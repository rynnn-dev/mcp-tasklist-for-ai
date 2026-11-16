import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { initProjectConfig } from "../src/config/project-config.ts";
import { TaskScheduler } from "../src/domain/scheduler.ts";
import { DatabaseManager } from "../src/storage/database.ts";
import { TaskRepository } from "../src/storage/task-repository.ts";
import { TasklistError } from "../src/types.ts";

let tempRoot = "";
let dbManager: DatabaseManager;
let scheduler: TaskScheduler;

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), "mcp-tasklist-guards-test-"));
  dbManager = new DatabaseManager(path.join(tempRoot, "central.db"));
  scheduler = new TaskScheduler(new TaskRepository(dbManager));
});

afterEach(() => {
  dbManager.close();
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("Autonomous Guardrails: Active Verification Gate, Stale Recovery, & File Scope Locks", () => {
  test("Active Verification Gate rejects failing commands, tracks attempts, enforces two-tier baseline, and transitions to failed at max_attempts", async () => {
    const projDir = path.join(tempRoot, "verify-proj");
    mkdirSync(projDir, { recursive: true });

    initProjectConfig({
      dir: projDir,
      projectName: "verify-proj",
      defaultVerificationCommand: "exit 0",
      maxAttempts: 2,
    });

    scheduler.createTasksBatch(projDir, [
      {
        title: "Failing task command",
        verification_command: "echo 'lint fail' >&2 && exit 1",
      },
      {
        title: "Passing task command",
        verification_command: "echo 'unit pass'",
      },
    ]);

    const c1 = scheduler.claimNextTask(projDir, "agent-a");
    expect(c1.task?.id).toBe("TASK-1");

    // Attempt 1 fails -> stays in_progress, attempt_count = 1
    try {
      await scheduler.completeTask(projDir, "TASK-1", {
        agent_id: "agent-a",
        verification_note: "Attempt 1",
      });
      expect.unreachable("Expected VERIFICATION_FAILED");
    } catch (err) {
      expect(err).toBeInstanceOf(TasklistError);
      expect((err as TasklistError).code).toBe("VERIFICATION_FAILED");
      expect((err as TasklistError).message).toContain("lint fail");
    }

    let detail = scheduler.getTaskDetail(projDir, "TASK-1");
    expect(detail.task.status).toBe("in_progress");
    expect(detail.task.attempt_count).toBe(1);
    expect(detail.task.last_verification_output).toContain("lint fail");

    // Attempt 2 fails -> reaches max_attempts (2) -> transitions to failed & releases lock
    try {
      await scheduler.completeTask(projDir, "TASK-1", {
        agent_id: "agent-a",
        verification_note: "Attempt 2",
      });
      expect.unreachable("Expected VERIFICATION_FAILED");
    } catch (err) {
      expect((err as TasklistError).code).toBe("VERIFICATION_FAILED");
    }

    detail = scheduler.getTaskDetail(projDir, "TASK-1");
    expect(detail.task.status).toBe("failed");
    expect(detail.task.attempt_count).toBe(2);
    expect(detail.task.claimed_by).toBeNull();

    // Two-tier enforcement: update project default verification command to fail
    initProjectConfig({
      dir: projDir,
      force: true,
      defaultVerificationCommand: "echo 'baseline typecheck failed' && exit 2",
      maxAttempts: 3,
    });

    const c2 = scheduler.claimNextTask(projDir, "agent-a");
    expect(c2.task?.id).toBe("TASK-2");

    try {
      await scheduler.completeTask(projDir, "TASK-2", {
        agent_id: "agent-a",
        verification_note: "Unit passed but baseline fails",
      });
      expect.unreachable("Expected baseline VERIFICATION_FAILED");
    } catch (err) {
      expect((err as TasklistError).code).toBe("VERIFICATION_FAILED");
      expect((err as TasklistError).message).toContain("baseline typecheck failed");
    }

    // Fix project baseline -> TASK-2 succeeds
    initProjectConfig({
      dir: projDir,
      force: true,
      defaultVerificationCommand: "echo 'baseline ok'",
      maxAttempts: 3,
    });

    const done2 = await scheduler.completeTask(projDir, "TASK-2", {
      agent_id: "agent-a",
      verification_note: "Both task and project checks pass",
      handoff_notes: "Ready for integration",
    });
    expect(done2.task.status).toBe("done");
    expect(done2.verification.passed).toBe(true);
    expect(done2.verification.steps.length).toBe(2);

    // Since TASK-1 is still failed, claimNextTask must report BLOCKED_BY_FAILURES
    const stalled = scheduler.claimNextTask(projDir, "agent-a");
    expect(stalled.outcome).toBe("BLOCKED_BY_FAILURES");
    expect(stalled.blocked_or_failed_tasks.map((t) => t.id)).toEqual(["TASK-1"]);
  });

  test("Active Verification Gate enforces verification_timeout_ms", async () => {
    const projDir = path.join(tempRoot, "timeout-proj");
    mkdirSync(projDir, { recursive: true });
    initProjectConfig({
      dir: projDir,
      projectName: "timeout-proj",
      verificationTimeoutMs: 1000,
      maxAttempts: 3,
    });

    scheduler.createTasksBatch(projDir, [
      {
        title: "Hanging verification command",
        verification_command: "sleep 5",
      },
    ]);

    scheduler.claimNextTask(projDir, "agent-1");
    try {
      await scheduler.completeTask(projDir, "TASK-1", {
        agent_id: "agent-1",
        verification_note: "Testing timeout",
      });
      expect.unreachable("Expected timeout failure");
    } catch (err) {
      expect(err).toBeInstanceOf(TasklistError);
      expect((err as TasklistError).code).toBe("VERIFICATION_FAILED");
      expect((err as TasklistError).message).toContain("exceeded 1000ms");
    }
  });

  test("Stale Lease Recovery automatically reclaims timed-out in_progress tasks with preserved handoffs", () => {
    const projDir = path.join(tempRoot, "stale-proj");
    mkdirSync(projDir, { recursive: true });
    const init = initProjectConfig({
      dir: projDir,
      projectName: "stale-proj",
      leaseTimeoutMinutes: 10,
      maxAttempts: 3,
    });

    scheduler.createTasksBatch(projDir, [{ title: "Long running task" }]);
    const firstClaim = scheduler.claimNextTask(projDir, "crashed-worker");
    expect(firstClaim.task?.id).toBe("TASK-1");
    scheduler.updateTask(projDir, "TASK-1", {
      handoff_notes: "Completed 50% of parser",
    });

    // Simulate 15 minutes elapsed without heartbeat
    const staleIso = new Date(Date.now() - 15 * 60_000).toISOString();
    dbManager.db
      .query("UPDATE tasks SET heartbeat_at = ?, claimed_at = ? WHERE project_id = ? AND id = ?")
      .run(staleIso, staleIso, init.config.project_id, "TASK-1");

    const reclaimed = scheduler.claimNextTask(projDir, "recovery-worker");
    expect(reclaimed.outcome).toBe("TASK_CLAIMED");
    expect(reclaimed.stale_reclaimed_task_ids).toEqual(["TASK-1"]);
    expect(reclaimed.task?.claimed_by).toBe("recovery-worker");
    expect(reclaimed.task?.attempt_count).toBe(1);
    expect(reclaimed.task?.handoff_notes).toContain("Completed 50% of parser");
    expect(reclaimed.task?.handoff_notes).toContain("Stale lease reclaimed");
  });

  test("File Scope Conflict Detection skips overlapping tasks and reports WAITING_ON_ACTIVE_TASKS", async () => {
    const projDir = path.join(tempRoot, "filelock-proj");
    mkdirSync(projDir, { recursive: true });
    initProjectConfig({ dir: projDir, projectName: "filelock-proj" });

    scheduler.createTasksBatch(projDir, [
      {
        title: "Edit router for users",
        priority: "high",
        affected_files: ["src/router.ts", "src/users.ts"],
      },
      {
        title: "Edit router for billing",
        priority: "high",
        affected_files: ["./src/router.ts", "src/billing.ts"],
      },
      {
        title: "Write standalone utils",
        priority: "medium",
        affected_files: ["src/utils.ts"],
      },
    ]);

    // Worker 1 claims TASK-1 (locks src/router.ts & src/users.ts)
    const c1 = scheduler.claimNextTask(projDir, "worker-1");
    expect(c1.task?.id).toBe("TASK-1");

    // Worker 2 calls claim_next_task -> TASK-2 conflicts on src/router.ts, so TASK-3 is selected!
    const c2 = scheduler.claimNextTask(projDir, "worker-2");
    expect(c2.outcome).toBe("TASK_CLAIMED");
    expect(c2.task?.id).toBe("TASK-3");
    expect(c2.skipped_due_to_file_locks.length).toBe(1);
    expect(c2.skipped_due_to_file_locks[0]?.task_id).toBe("TASK-2");
    expect(c2.skipped_due_to_file_locks[0]?.conflicting_files).toEqual(["src/router.ts"]);

    // Worker 3 calls claim_next_task -> only TASK-2 remains, waiting on TASK-1's file lock
    const c3 = scheduler.claimNextTask(projDir, "worker-3");
    expect(c3.outcome).toBe("WAITING_ON_ACTIVE_TASKS");
    expect(c3.skipped_due_to_file_locks[0]?.task_id).toBe("TASK-2");

    // Once Worker 1 finishes TASK-1, TASK-2 becomes claimable
    await scheduler.completeTask(projDir, "TASK-1", {
      agent_id: "worker-1",
      verification_note: "Users route added",
    });
    await scheduler.completeTask(projDir, "TASK-3", {
      agent_id: "worker-2",
      verification_note: "Utils done",
    });

    const c4 = scheduler.claimNextTask(projDir, "worker-3");
    expect(c4.outcome).toBe("TASK_CLAIMED");
    expect(c4.task?.id).toBe("TASK-2");

    await scheduler.completeTask(projDir, "TASK-2", {
      agent_id: "worker-3",
      verification_note: "Billing route added",
    });

    const finalState = scheduler.claimNextTask(projDir, "worker-1");
    expect(finalState.outcome).toBe("PROJECT_COMPLETED");
  });
});
