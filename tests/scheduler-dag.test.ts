import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  doRepoPathsConflict,
  initProjectConfig,
  normalizeRepoPaths,
} from "../src/config/project-config.ts";
import { computeTopologicalWaves } from "../src/domain/dag.ts";
import { TaskScheduler } from "../src/domain/scheduler.ts";
import { DatabaseManager } from "../src/storage/database.ts";
import { TaskRepository } from "../src/storage/task-repository.ts";
import { TasklistError } from "../src/types.ts";

let tempRoot = "";
let dbManager: DatabaseManager;
let scheduler: TaskScheduler;

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), "mcp-tasklist-dag-test-"));
  dbManager = new DatabaseManager(path.join(tempRoot, "central.db"));
  scheduler = new TaskScheduler(new TaskRepository(dbManager));
});

afterEach(() => {
  dbManager.close();
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("Scheduler DAG, isolation, shared context, and dynamic task splitting", () => {
  test("rejects uninitialized directories with PROJECT_NOT_INITIALIZED", () => {
    const uninitDir = path.join(tempRoot, "not-init");
    mkdirSync(uninitDir, { recursive: true });

    expect(() =>
      scheduler.createTasksBatch(uninitDir, [{ title: "Should fail" }])
    ).toThrow(TasklistError);

    try {
      scheduler.getProjectSummary(uninitDir);
    } catch (err) {
      expect(err).toBeInstanceOf(TasklistError);
      expect((err as TasklistError).code).toBe("PROJECT_NOT_INITIALIZED");
    }
  });

  test("isolates two projects strictly even inside two clones OR same directory with custom config", () => {
    const repoCloneA = path.join(tempRoot, "clone-a");
    const repoCloneB = path.join(tempRoot, "clone-b");
    mkdirSync(repoCloneA, { recursive: true });
    mkdirSync(repoCloneB, { recursive: true });

    initProjectConfig({ dir: repoCloneA, projectName: "clone-a" });
    initProjectConfig({ dir: repoCloneB, projectName: "clone-b" });
    // Second config inside clone-a directory
    initProjectConfig({
      dir: repoCloneA,
      projectName: "clone-a-hotfix",
      configFileName: ".moex.hotfix.json",
    });

    scheduler.createTasksBatch(repoCloneA, [{ title: "Task in Clone A main" }]);
    scheduler.createTasksBatch(repoCloneB, [{ title: "Task in Clone B" }]);
    scheduler.createTasksBatch(
      repoCloneA,
      [{ title: "Task in Clone A hotfix" }],
      { configFileName: ".moex.hotfix.json" }
    );

    const tasksA = scheduler.listTasks(repoCloneA);
    const tasksB = scheduler.listTasks(repoCloneB);
    const tasksHotfix = scheduler.listTasks(
      repoCloneA,
      {},
      ".moex.hotfix.json"
    );

    expect(tasksA.map((t) => t.title)).toEqual(["Task in Clone A main"]);
    expect(tasksB.map((t) => t.title)).toEqual(["Task in Clone B"]);
    expect(tasksHotfix.map((t) => t.title)).toEqual(["Task in Clone A hotfix"]);
  });

  test("supports batch DAG creation with local keys, priority ordering, wave computation, and cycle rejection", async () => {
    const projDir = path.join(tempRoot, "dag-proj");
    mkdirSync(projDir, { recursive: true });
    initProjectConfig({
      dir: projDir,
      projectName: "dag-proj",
      requireVerificationNote: true,
    });

    scheduler.setProjectContext(projDir, {
      architecture_summary: "Modular TypeScript service",
      tech_stack: { runtime: "Bun", db: "SQLite" },
      shared_contracts: { api_port: 4000 },
    });
    // Merge update preserves architecture_summary while adding conventions
    scheduler.setProjectContext(projDir, {
      conventions: ["Strict TS", "No console.log"],
      shared_contracts: { auth_header: "Authorization" },
    });

    const created = scheduler.createTasksBatch(projDir, [
      {
        key: "schema",
        title: "Create DB schema",
        priority: "medium",
        affected_files: ["src/db.ts"],
      },
      {
        key: "api",
        title: "Build API server",
        priority: "high",
        depends_on: ["schema"],
        affected_files: ["src/server.ts"],
      },
      {
        key: "docs",
        title: "Write initial README",
        priority: "low",
        affected_files: ["README.md"],
      },
    ]);

    expect(created.tasks.map((t) => t.id)).toEqual(["TASK-1", "TASK-2", "TASK-3"]);
    const waves = computeTopologicalWaves(created.tasks);
    expect(waves).toEqual([
      { wave: 0, task_ids: ["TASK-1", "TASK-3"] },
      { wave: 1, task_ids: ["TASK-2"] },
    ]);

    // Cycle detection (batch cycle A -> B -> A) rolls back atomically
    try {
      scheduler.createTasksBatch(projDir, [
        { key: "a", title: "Cycle A", depends_on: ["b"] },
        { key: "b", title: "Cycle B", depends_on: ["a"] },
      ]);
      expect.unreachable("Should have thrown CYCLE_DETECTED");
    } catch (err) {
      expect(err).toBeInstanceOf(TasklistError);
      expect((err as TasklistError).code).toBe("CYCLE_DETECTED");
    }
    // Verify rollback left task count unchanged at 3
    expect(scheduler.listTasks(projDir).length).toBe(3);

    // Cycle detection when mutating existing dependency (TASK-1 depends_on TASK-2 while TASK-2 depends_on TASK-1)
    try {
      scheduler.updateTask(projDir, "TASK-1", { add_depends_on: ["TASK-2"] });
      expect.unreachable("Should have thrown CYCLE_DETECTED");
    } catch (err) {
      expect(err).toBeInstanceOf(TasklistError);
      expect((err as TasklistError).code).toBe("CYCLE_DETECTED");
    }

    // Claim next chooses TASK-1 over TASK-3 due to medium > low priority
    const claim1 = scheduler.claimNextTask(projDir, "worker-1");
    expect(claim1.outcome).toBe("TASK_CLAIMED");
    expect(claim1.task?.id).toBe("TASK-1");
    expect(claim1.project_shared_context.architecture_summary).toBe(
      "Modular TypeScript service"
    );
    expect(claim1.project_shared_context.shared_contracts).toEqual({
      api_port: 4000,
      auth_header: "Authorization",
    });

    await scheduler.completeTask(projDir, "TASK-1", {
      agent_id: "worker-1",
      verification_note: "Schema verified",
      handoff_notes: "Exported DbClient from src/db.ts",
      modified_files: ["./src/db.ts"],
    });

    // Next claim should pick TASK-2 (high priority, now unblocked) and hydrate TASK-1 handoff
    const claim2 = scheduler.claimNextTask(projDir, "worker-1");
    expect(claim2.outcome).toBe("TASK_CLAIMED");
    expect(claim2.task?.id).toBe("TASK-2");
    expect(claim2.prerequisite_handoffs).toEqual([
      {
        task_id: "TASK-1",
        title: "Create DB schema",
        status: "done",
        handoff_notes: "Exported DbClient from src/db.ts",
        modified_files: ["src/db.ts"],
        verification_note: "Schema verified",
      },
    ]);
  });

  test("dynamic task splitting via blocks_task_ids suspends active task and prioritizes prerequisite", async () => {
    const projDir = path.join(tempRoot, "split-proj");
    mkdirSync(projDir, { recursive: true });
    initProjectConfig({ dir: projDir, projectName: "split-proj" });

    scheduler.createTasksBatch(projDir, [
      { title: "Implement OAuth controller", priority: "high" },
    ]);

    const claim = scheduler.claimNextTask(projDir, "agent-1");
    expect(claim.task?.id).toBe("TASK-1");
    scheduler.updateTask(
      projDir,
      "TASK-1",
      {
        handoff_notes: "Drafted callback route; discovered missing crypto helper",
      },
      "agent-1"
    );

    // Inject prerequisite TASK-2 blocking active TASK-1
    const injected = scheduler.createTasksBatch(projDir, [
      {
        title: "Add PKCE crypto utility",
        priority: "high",
        blocks_task_ids: ["TASK-1"],
      },
    ]);
    expect(injected.suspended_task_ids).toEqual(["TASK-1"]);

    const detail1 = scheduler.getTaskDetail(projDir, "TASK-1");
    expect(detail1.task.status).toBe("pending");
    expect(detail1.task.claimed_by).toBeNull();
    expect(detail1.task.depends_on).toEqual(["TASK-2"]);
    expect(detail1.task.handoff_notes).toContain("Auto-suspended");

    // Next claim MUST pick TASK-2 first
    const nextClaim = scheduler.claimNextTask(projDir, "agent-1");
    expect(nextClaim.outcome).toBe("TASK_CLAIMED");
    expect(nextClaim.task?.id).toBe("TASK-2");

    await scheduler.completeTask(projDir, "TASK-2", {
      agent_id: "agent-1",
      verification_note: "PKCE helper implemented",
      handoff_notes: "Use createPkcePair() from src/pkce.ts",
    });

    // Now TASK-1 is claimable again with both its suspended notes and TASK-2 handoff
    const resumedClaim = scheduler.claimNextTask(projDir, "agent-1");
    expect(resumedClaim.task?.id).toBe("TASK-1");
    expect(resumedClaim.task?.handoff_notes).toContain("Drafted callback route");
    expect(resumedClaim.prerequisite_handoffs[0]?.handoff_notes).toContain(
      "createPkcePair"
    );
  });

  test("delete_task prevents breaking dependents unless force=true", () => {
    const projDir = path.join(tempRoot, "delete-proj");
    mkdirSync(projDir, { recursive: true });
    initProjectConfig({ dir: projDir, projectName: "delete-proj" });

    scheduler.createTasksBatch(projDir, [
      { key: "p", title: "Parent" },
      { key: "c", title: "Child", depends_on: ["p"] },
    ]);

    expect(() => scheduler.deleteTask(projDir, "TASK-1", false)).toThrow(
      TasklistError
    );

    const res = scheduler.deleteTask(projDir, "TASK-1", true);
    expect(res.deleted_task_id).toBe("TASK-1");
    expect(res.unlinked_dependents).toEqual(["TASK-2"]);
    expect(scheduler.getTaskDetail(projDir, "TASK-2").task.depends_on).toEqual([]);

    // Deleting the highest task (TASK-2) must NOT cause the next created task to reuse TASK-2
    scheduler.deleteTask(projDir, "TASK-2", false);
    const nextBatch = scheduler.createTasksBatch(projDir, [
      { title: "Fresh task after deletion" },
    ]);
    expect(nextBatch.tasks[0]?.id).toBe("TASK-3");
    expect(nextBatch.tasks[0]?.seq_num).toBe(3);

    const detail3 = scheduler.getTaskDetail(projDir, "TASK-3");
    expect(detail3.events.every((e) => e.event_type !== "TASK_DELETED")).toBe(true);
  });

  test("updateTask(add_depends_on) enforces DAG invariants and claimNextTask(category) avoids false BLOCKED_BY_FAILURES", async () => {
    const projDir = path.join(tempRoot, "dag-invariant-proj");
    mkdirSync(projDir, { recursive: true });
    initProjectConfig({ dir: projDir, projectName: "dag-invariant-proj" });

    scheduler.createTasksBatch(projDir, [
      { key: "infra", title: "Setup infra", category: "infra" },
      { key: "api", title: "Build API", category: "backend", depends_on: ["infra"] },
      { key: "docs", title: "Write docs", category: "docs" },
    ]);

    // Filtering by category="backend" when TASK-2 is pending its "infra" prerequisite (zero failures)
    // must report WAITING_ON_ACTIVE_TASKS, NOT BLOCKED_BY_FAILURES
    const backendWaiting = scheduler.claimNextTask(projDir, "backend-agent", {
      category: "backend",
    });
    expect(backendWaiting.outcome).toBe("WAITING_ON_ACTIVE_TASKS");

    // Claim and complete TASK-1 ("infra")
    const claimInfra = scheduler.claimNextTask(projDir, "infra-agent", {
      category: "infra",
    });
    expect(claimInfra.task?.id).toBe("TASK-1");
    await scheduler.completeTask(projDir, "TASK-1", {
      agent_id: "infra-agent",
      verification_note: "Infra ready",
    });

    // Cannot add unfinished dependency TASK-3 onto already-done TASK-1
    expect(() =>
      scheduler.updateTask(projDir, "TASK-1", { add_depends_on: ["TASK-3"] })
    ).toThrow(TasklistError);

    // Claim TASK-2 ("api") -> adding unfinished dependency TASK-3 auto-suspends TASK-2 back to pending
    const claimApi = scheduler.claimNextTask(projDir, "backend-agent", {
      category: "backend",
    });
    expect(claimApi.task?.id).toBe("TASK-2");

    const suspendedApi = scheduler.updateTask(
      projDir,
      "TASK-2",
      { add_depends_on: ["TASK-3"] },
      "backend-agent"
    );
    expect(suspendedApi.status).toBe("pending");
    expect(suspendedApi.claimed_by).toBeNull();
    expect(suspendedApi.depends_on).toEqual(["TASK-1", "TASK-3"]);
    expect(suspendedApi.handoff_notes).toContain("Auto-suspended");
  });

  test("enforces updateTask state/reopen/flag guards, rejects reserved keys, and isolates failed categories", async () => {
    const projDir = path.join(tempRoot, "state-guards-proj");
    mkdirSync(projDir, { recursive: true });
    initProjectConfig({ dir: projDir, projectName: "state-guards-proj" });

    // Reject reserved TASK-\d+ local keys
    expect(() =>
      scheduler.createTasksBatch(projDir, [{ key: "TASK-1", title: "Reserved key" }])
    ).toThrow(TasklistError);
    expect(() =>
      scheduler.createTasksBatch(projDir, [{ key: "task-42", title: "Reserved lower" }])
    ).toThrow(TasklistError);

    scheduler.createTasksBatch(projDir, [
      { key: "base", title: "Base task", category: "backend" },
      { key: "child", title: "Child task", category: "backend", depends_on: ["base"] },
      { key: "broken", title: "Broken other category", category: "ops" },
    ]);

    // Fail ops task; backend claim must still succeed (not blocked by failed ops task)
    const opsClaim = scheduler.claimNextTask(projDir, "ops-agent", { category: "ops" });
    expect(opsClaim.task?.id).toBe("TASK-3");
    scheduler.blockOrFailTask(projDir, "TASK-3", {
      agent_id: "ops-agent",
      outcome: "failed",
      reason: "Ops environment broken",
    });

    const backendClaim = scheduler.claimNextTask(projDir, "be-agent", {
      category: "backend",
    });
    expect(backendClaim.outcome).toBe("TASK_CLAIMED");
    expect(backendClaim.task?.id).toBe("TASK-1");

    // Reject conflicting release_claim + reset_to_pending
    expect(() =>
      scheduler.updateTask(
        projDir,
        "TASK-1",
        { release_claim: true, reset_to_pending: true },
        "be-agent"
      )
    ).toThrow(TasklistError);

    await scheduler.completeTask(projDir, "TASK-1", {
      agent_id: "be-agent",
      verification_note: "Base complete",
    });

    // Cannot mutate done task without reset_to_pending=true
    expect(() =>
      scheduler.updateTask(
        projDir,
        "TASK-1",
        { title: "Silent edit on done task" },
        "be-agent"
      )
    ).toThrow(TasklistError);

    // Claim TASK-2 (child of TASK-1); reopening TASK-1 must fail while dependent TASK-2 is in_progress
    const childClaim = scheduler.claimNextTask(projDir, "be-agent", {
      category: "backend",
    });
    expect(childClaim.task?.id).toBe("TASK-2");

    expect(() =>
      scheduler.updateTask(
        projDir,
        "TASK-1",
        { reset_to_pending: true },
        "be-agent"
      )
    ).toThrow(TasklistError);

    // Also cannot reopen TASK-1 if TASK-2 is already done
    await scheduler.completeTask(projDir, "TASK-2", {
      agent_id: "be-agent",
      verification_note: "Child complete",
    });
    expect(() =>
      scheduler.updateTask(
        projDir,
        "TASK-1",
        { reset_to_pending: true },
        "be-agent"
      )
    ).toThrow(TasklistError);
  });

  test("normalizeRepoPaths handles Windows separators, internal aliases, dangling symlinks, and doRepoPathsConflict glob overlaps", () => {
    const projDir = path.join(tempRoot, "paths-proj");
    mkdirSync(path.join(projDir, "src", "real-dir"), { recursive: true });
    writeFileSync(path.join(projDir, "src", "real-dir", "auth.ts"), "export {};\n", "utf8");

    // Backslash normalization + canonicalization of internal symlink alias
    symlinkSync(
      path.join(projDir, "src", "real-dir"),
      path.join(projDir, "src", "alias-dir"),
      "dir"
    );
    expect(
      normalizeRepoPaths(projDir, ["src\\alias-dir\\auth.ts", "./src/real-dir/new.ts"])
    ).toEqual(["src/real-dir/auth.ts", "src/real-dir/new.ts"]);

    // Dangling symlink must be rejected
    symlinkSync(
      path.join(tempRoot, "nonexistent-outside-target"),
      path.join(projDir, "src", "dangling-link")
    );
    expect(() => normalizeRepoPaths(projDir, ["src/dangling-link/file.ts"])).toThrow(
      TasklistError
    );

    // Deep glob overlaps against directories and other globs
    expect(doRepoPathsConflict("src/**/*.ts", "src/auth")).toBe(true);
    expect(doRepoPathsConflict("**/*.ts", "src/auth/*")).toBe(true);
    expect(doRepoPathsConflict("src/*/*.ts", "src/api/*")).toBe(true);
    expect(doRepoPathsConflict("src/auth/*.ts", "docs/readme.md")).toBe(false);
  });
});
