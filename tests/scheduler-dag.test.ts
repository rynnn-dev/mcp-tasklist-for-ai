import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { initProjectConfig } from "../src/config/project-config.ts";
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
    scheduler.updateTask(projDir, "TASK-1", {
      handoff_notes: "Drafted callback route; discovered missing crypto helper",
    });

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
  });
});
