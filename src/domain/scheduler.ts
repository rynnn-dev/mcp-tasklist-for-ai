import {
  doRepoPathsConflict,
  normalizeRepoPaths,
  resolveProjectConfig,
} from "../config/project-config.ts";
import { TaskRepository } from "../storage/task-repository.ts";
import {
  PRIORITY_WEIGHT,
  ProjectSharedContextSchema,
  TasklistError,
  type ClaimNextResult,
  type PrerequisiteHandoff,
  type ProjectRecord,
  type ProjectSharedContext,
  type ResolvedProject,
  type TaskEventRecord,
  type TaskPriority,
  type TaskRecord,
  type TaskStatus,
  type VerificationResult,
} from "../types.ts";
import {
  computeTopologicalWaves,
  validateNoCycles,
  type DependencyEdge,
} from "./dag.ts";
import { runVerificationGate } from "./verifier.ts";

export interface CreateTaskInput {
  key?: string;
  title: string;
  description?: string;
  category?: string;
  priority?: TaskPriority;
  acceptance_criteria?: string[];
  verification_command?: string | null;
  affected_files?: string[];
  depends_on?: string[];
  blocks_task_ids?: string[];
}

export interface ListTasksFilter {
  status?: TaskStatus;
  priority?: TaskPriority;
  category?: string;
  claimed_by?: string;
  only_actionable?: boolean;
}

export interface ClaimNextOptions {
  category?: string;
  ignore_file_locks?: boolean;
  prefer_task_id?: string;
}

export interface UpdateTaskPatch {
  title?: string;
  description?: string;
  category?: string;
  priority?: TaskPriority;
  acceptance_criteria?: string[];
  verification_command?: string | null;
  affected_files?: string[];
  modified_files?: string[];
  append_modified_files?: boolean;
  handoff_notes?: string;
  heartbeat?: boolean;
  reset_to_pending?: boolean;
  reset_attempts?: boolean;
  add_depends_on?: string[];
  remove_depends_on?: string[];
}

export interface CompleteTaskParams {
  agent_id?: string;
  verification_note?: string;
  handoff_notes?: string;
  modified_files?: string[];
  skip_verification_run?: boolean;
}

export interface CompleteTaskResult {
  task: TaskRecord;
  verification: VerificationResult;
  newly_unblocked_task_ids: string[];
  remaining_open_tasks: number;
}

export interface BlockOrFailParams {
  agent_id?: string;
  outcome: "blocked" | "failed" | "retry_later";
  reason: string;
  handoff_notes?: string;
  modified_files?: string[];
}

export interface ProjectSummaryResult {
  project: ProjectRecord;
  config: ResolvedProject["config"];
  counts: Record<TaskStatus, number> & { total: number; actionable: number };
  completion_percentage: number;
  actionable_task_ids: string[];
  active_tasks: Array<{
    id: string;
    title: string;
    claimed_by: string | null;
    claimed_at: string | null;
    heartbeat_at: string | null;
    is_stale: boolean;
    affected_files: string[];
  }>;
  blocked_or_failed_tasks: Array<{
    id: string;
    title: string;
    status: TaskStatus;
    attempt_count: number;
    blocker_reason: string;
  }>;
  execution_waves: Array<{ wave: number; task_ids: string[] }>;
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

function mergeSharedContext(
  existing: ProjectSharedContext,
  patch: ProjectSharedContext,
  replace: boolean
): ProjectSharedContext {
  if (replace) {
    return ProjectSharedContextSchema.parse(patch);
  }
  const merged: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const prev = merged[key];
    if (isPlainObject(prev) && isPlainObject(value)) {
      merged[key] = { ...prev, ...value };
    } else {
      merged[key] = value;
    }
  }
  return ProjectSharedContextSchema.parse(merged);
}

function isTaskStale(task: TaskRecord, leaseTimeoutMinutes: number, nowMs: number): boolean {
  if (task.status !== "in_progress") return false;
  const ref = task.heartbeat_at ?? task.claimed_at;
  if (!ref) return false;
  const refMs = Date.parse(ref);
  if (Number.isNaN(refMs)) return false;
  return nowMs - refMs >= leaseTimeoutMinutes * 60_000;
}

export class TaskScheduler {
  constructor(private readonly repo: TaskRepository) {}

  public syncResolvedProject(resolved: ResolvedProject): ProjectRecord {
    return this.repo.upsertProject(resolved);
  }

  private resolveAndSync(
    projectPath?: string,
    configFileName?: string
  ): { resolved: ResolvedProject; project: ProjectRecord } {
    const resolved = resolveProjectConfig(projectPath, configFileName);
    const project = this.repo.upsertProject(resolved);
    return { resolved, project };
  }

  public setProjectContext(
    projectPath: string | undefined,
    contextPatch: ProjectSharedContext,
    options: { replace?: boolean; actor?: string; configFileName?: string } = {}
  ): ProjectRecord {
    const validatedPatch = ProjectSharedContextSchema.parse(contextPatch);
    const actor = options.actor?.trim() || "agent";

    return this.repo.withTransaction(() => {
      const { resolved, project } = this.resolveAndSync(
        projectPath,
        options.configFileName
      );
      const nextContext = mergeSharedContext(
        project.shared_context,
        validatedPatch,
        options.replace ?? false
      );
      const updated = this.repo.updateProjectSharedContext(
        resolved.config.project_id,
        nextContext
      );
      this.repo.recordEvent(
        resolved.config.project_id,
        null,
        "PROJECT_CONTEXT_UPDATED",
        actor,
        { replace: options.replace ?? false, keys: Object.keys(validatedPatch) }
      );
      return updated;
    });
  }

  public getProjectContext(
    projectPath?: string,
    configFileName?: string
  ): { project: ProjectRecord; config: ResolvedProject["config"] } {
    return this.repo.withTransaction(() => {
      const { resolved, project } = this.resolveAndSync(projectPath, configFileName);
      return { project, config: resolved.config };
    });
  }

  public createTasksBatch(
    projectPath: string | undefined,
    inputs: readonly CreateTaskInput[],
    options: { actor?: string; configFileName?: string } = {}
  ): { tasks: TaskRecord[]; suspended_task_ids: string[] } {
    if (inputs.length === 0) {
      throw new TasklistError(
        "VALIDATION_ERROR",
        "create_tasks requires at least 1 task item."
      );
    }

    const actor = options.actor?.trim() || "agent";

    return this.repo.withTransaction(() => {
      const { resolved } = this.resolveAndSync(projectPath, options.configFileName);
      const projectId = resolved.config.project_id;
      const existingTasks = this.repo.listTasksByProject(projectId);
      const existingMap = new Map(existingTasks.map((t) => [t.id, t]));

      let nextSeq = this.repo.getNextSeqNum(projectId);
      const keyToId = new Map<string, string>();
      const prepared: Array<{
        id: string;
        seq_num: number;
        input: CreateTaskInput;
        affected_files: string[];
      }> = [];

      for (const item of inputs) {
        const title = item.title.trim();
        if (!title) {
          throw new TasklistError("VALIDATION_ERROR", "Task title cannot be empty.");
        }
        const id = `TASK-${nextSeq}`;
        if (item.key !== undefined) {
          const key = item.key.trim();
          if (!key) {
            throw new TasklistError(
              "VALIDATION_ERROR",
              `Task "${title}" has an empty local key.`
            );
          }
          if (keyToId.has(key) || existingMap.has(key)) {
            throw new TasklistError(
              "VALIDATION_ERROR",
              `Duplicate or colliding task key "${key}".`
            );
          }
          keyToId.set(key, id);
        }

        const affectedFiles = normalizeRepoPaths(
          resolved.project_root,
          item.affected_files ?? []
        );

        prepared.push({
          id,
          seq_num: nextSeq,
          input: item,
          affected_files: affectedFiles,
        });
        nextSeq += 1;
      }

      const resolveRef = (ref: string, ownerTitle: string): string => {
        const trimmed = ref.trim();
        const mapped = keyToId.get(trimmed);
        if (mapped) return mapped;
        if (existingMap.has(trimmed)) return trimmed;
        throw new TasklistError(
          "INVALID_DEPENDENCY",
          `Task "${ownerTitle}" references unknown dependency/target "${trimmed}".`,
          { reference: trimmed }
        );
      };

      const allTaskIds = new Set<string>(existingMap.keys());
      for (const p of prepared) {
        allTaskIds.add(p.id);
      }

      const existingEdges = this.repo.getAllDependencies(projectId);
      const edgeSet = new Set<string>(
        existingEdges.map((e) => `${e.task_id}=>${e.depends_on_task_id}`)
      );
      const newEdges: DependencyEdge[] = [];
      const suspendedTriggers = new Map<string, string[]>();

      const addEdge = (taskId: string, dependsOnId: string): void => {
        const key = `${taskId}=>${dependsOnId}`;
        if (!edgeSet.has(key)) {
          edgeSet.add(key);
          newEdges.push({ task_id: taskId, depends_on_task_id: dependsOnId });
        }
      };

      for (const p of prepared) {
        for (const depRef of p.input.depends_on ?? []) {
          const depId = resolveRef(depRef, p.input.title);
          addEdge(p.id, depId);
        }

        for (const blockedRef of p.input.blocks_task_ids ?? []) {
          const blockedId = resolveRef(blockedRef, p.input.title);
          const existingBlocked = existingMap.get(blockedId);
          if (existingBlocked && existingBlocked.status === "done") {
            throw new TasklistError(
              "INVALID_STATE_TRANSITION",
              `Cannot inject prerequisite "${p.id}" before already-completed task "${blockedId}". Reopen "${blockedId}" with update_task(reset_to_pending=true) first or create a follow-up task.`
            );
          }
          addEdge(blockedId, p.id);
          if (existingBlocked && existingBlocked.status === "in_progress") {
            const list = suspendedTriggers.get(blockedId);
            if (list) {
              list.push(p.id);
            } else {
              suspendedTriggers.set(blockedId, [p.id]);
            }
          }
        }
      }

      const combinedEdges: DependencyEdge[] = [...existingEdges, ...newEdges];
      validateNoCycles(allTaskIds, combinedEdges);

      const now = new Date().toISOString();
      for (const p of prepared) {
        this.repo.insertTask({
          project_id: projectId,
          id: p.id,
          seq_num: p.seq_num,
          title: p.input.title.trim(),
          description: p.input.description?.trim() ?? "",
          category: p.input.category?.trim() || "general",
          status: "pending",
          priority: p.input.priority ?? "medium",
          acceptance_criteria: (p.input.acceptance_criteria ?? [])
            .map((c) => c.trim())
            .filter(Boolean),
          verification_command: p.input.verification_command?.trim() || null,
          affected_files: p.affected_files,
          modified_files: [],
          handoff_notes: "",
          verification_note: "",
          last_verification_output: "",
          claimed_by: null,
          claimed_at: null,
          heartbeat_at: null,
          attempt_count: 0,
          blocker_reason: "",
          created_at: now,
          updated_at: now,
          completed_at: null,
        });
      }

      if (prepared.length > 0) {
        this.repo.advanceProjectSeqNum(
          projectId,
          prepared[prepared.length - 1]!.seq_num
        );
      }

      for (const edge of newEdges) {
        this.repo.addDependency(projectId, edge.task_id, edge.depends_on_task_id);
      }

      const suspendedTaskIds: string[] = [];
      for (const [blockedId, prereqIds] of suspendedTriggers.entries()) {
        const existingBlocked = existingMap.get(blockedId)!;
        const suspendNote = `[Auto-suspended waiting on injected prerequisite(s): ${prereqIds.join(", ")}]`;
        const nextHandoff = existingBlocked.handoff_notes
          ? `${existingBlocked.handoff_notes}\n${suspendNote}`
          : suspendNote;

        this.repo.updateTaskRow(projectId, blockedId, {
          status: "pending",
          claimed_by: null,
          claimed_at: null,
          heartbeat_at: null,
          handoff_notes: nextHandoff,
          updated_at: now,
        });
        this.repo.recordEvent(
          projectId,
          blockedId,
          "TASK_SUSPENDED_BY_PREREQUISITE",
          actor,
          { prerequisite_ids: prereqIds }
        );
        suspendedTaskIds.push(blockedId);
      }

      for (const p of prepared) {
        this.repo.recordEvent(projectId, p.id, "TASK_CREATED", actor, {
          title: p.input.title.trim(),
          priority: p.input.priority ?? "medium",
        });
      }

      const createdTasks = prepared
        .map((p) => this.repo.getTaskById(projectId, p.id))
        .filter((t): t is TaskRecord => t !== null);

      return { tasks: createdTasks, suspended_task_ids: suspendedTaskIds };
    });
  }

  public listTasks(
    projectPath: string | undefined,
    filter: ListTasksFilter = {},
    configFileName?: string
  ): TaskRecord[] {
    return this.repo.withTransaction(() => {
      const { resolved } = this.resolveAndSync(projectPath, configFileName);
      const tasks = this.repo.listTasksByProject(resolved.config.project_id);
      const taskMap = new Map(tasks.map((t) => [t.id, t]));

      return tasks.filter((t) => {
        if (filter.status && t.status !== filter.status) return false;
        if (filter.priority && t.priority !== filter.priority) return false;
        if (filter.category && t.category !== filter.category) return false;
        if (filter.claimed_by && t.claimed_by !== filter.claimed_by) return false;
        if (filter.only_actionable) {
          if (t.status !== "pending") return false;
          const allDepsDone = t.depends_on.every(
            (depId) => taskMap.get(depId)?.status === "done"
          );
          if (!allDepsDone) return false;
        }
        return true;
      });
    });
  }

  public getTaskDetail(
    projectPath: string | undefined,
    taskId: string,
    configFileName?: string
  ): {
    task: TaskRecord;
    prerequisites: Array<{ id: string; title: string; status: TaskStatus; handoff_notes: string }>;
    dependents: Array<{ id: string; title: string; status: TaskStatus }>;
    events: TaskEventRecord[];
  } {
    return this.repo.withTransaction(() => {
      const { resolved } = this.resolveAndSync(projectPath, configFileName);
      const projectId = resolved.config.project_id;
      const allTasks = this.repo.listTasksByProject(projectId);
      const taskMap = new Map(allTasks.map((t) => [t.id, t]));
      const task = taskMap.get(taskId);

      if (!task) {
        throw new TasklistError(
          "TASK_NOT_FOUND",
          `Task "${taskId}" not found in project "${resolved.config.project_name}".`
        );
      }

      const prerequisites = task.depends_on
        .map((id) => taskMap.get(id))
        .filter((t): t is TaskRecord => t !== undefined)
        .map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          handoff_notes: t.handoff_notes,
        }));

      const dependents = allTasks
        .filter((t) => t.depends_on.includes(taskId))
        .map((t) => ({ id: t.id, title: t.title, status: t.status }));

      const events = this.repo.getTaskEvents(projectId, taskId, 30);
      return { task, prerequisites, dependents, events };
    });
  }

  public claimNextTask(
    projectPath: string | undefined,
    agentId: string,
    options: ClaimNextOptions = {},
    configFileName?: string
  ): ClaimNextResult {
    const cleanAgentId = agentId.trim();
    if (!cleanAgentId) {
      throw new TasklistError(
        "VALIDATION_ERROR",
        "agent_id cannot be empty when claiming a task."
      );
    }

    return this.repo.withTransaction(() => {
      const { resolved, project } = this.resolveAndSync(
        projectPath,
        configFileName
      );
      const projectId = resolved.config.project_id;
      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();

      const allTasks = this.repo.listTasksByProject(projectId);
      const staleReclaimedIds: string[] = [];
      const staleFailedIds: string[] = [];

      // 1. Stale lease recovery
      for (const task of allTasks) {
        if (isTaskStale(task, resolved.config.lease_timeout_minutes, nowMs)) {
          const prevOwner = task.claimed_by ?? "unknown";
          const nextAttempts = task.attempt_count + 1;
          const staleMsg = `[Stale lease reclaimed from ${prevOwner} after ${resolved.config.lease_timeout_minutes}m timeout]`;
          const nextHandoff = task.handoff_notes
            ? `${task.handoff_notes}\n${staleMsg}`
            : staleMsg;

          if (nextAttempts >= resolved.config.max_attempts) {
            const failReason = `Lease timed out after ${resolved.config.lease_timeout_minutes}m (last claimed by ${prevOwner}) and reached max_attempts (${resolved.config.max_attempts}).`;
            this.repo.updateTaskRow(projectId, task.id, {
              status: "failed",
              attempt_count: nextAttempts,
              claimed_by: null,
              claimed_at: null,
              heartbeat_at: null,
              handoff_notes: nextHandoff,
              blocker_reason: failReason,
              updated_at: nowIso,
            });
            this.repo.recordEvent(projectId, task.id, "TASK_STALE_FAILED", cleanAgentId, {
              previous_owner: prevOwner,
              attempt_count: nextAttempts,
            });
            task.status = "failed";
            task.attempt_count = nextAttempts;
            task.claimed_by = null;
            task.claimed_at = null;
            task.heartbeat_at = null;
            task.handoff_notes = nextHandoff;
            task.blocker_reason = failReason;
            staleFailedIds.push(task.id);
          } else {
            this.repo.updateTaskRow(projectId, task.id, {
              status: "pending",
              attempt_count: nextAttempts,
              claimed_by: null,
              claimed_at: null,
              heartbeat_at: null,
              handoff_notes: nextHandoff,
              updated_at: nowIso,
            });
            this.repo.recordEvent(
              projectId,
              task.id,
              "TASK_STALE_RECLAIMED",
              cleanAgentId,
              { previous_owner: prevOwner, attempt_count: nextAttempts }
            );
            task.status = "pending";
            task.attempt_count = nextAttempts;
            task.claimed_by = null;
            task.claimed_at = null;
            task.heartbeat_at = null;
            task.handoff_notes = nextHandoff;
            staleReclaimedIds.push(task.id);
          }
        }
      }

      const taskMap = new Map(allTasks.map((t) => [t.id, t]));

      // 2. Active file locks across all active in_progress tasks
      const activeTasks = allTasks.filter((t) => t.status === "in_progress");
      const activeLockedEntries: Array<{ taskId: string; patterns: string[] }> =
        activeTasks.map((active) => ({
          taskId: active.id,
          patterns: Array.from(
            new Set([...active.affected_files, ...active.modified_files])
          ),
        }));

      // 3. Find unblocked pending candidates
      const unblockedPending = allTasks.filter((t) => {
        if (t.status !== "pending") return false;
        if (options.category && t.category !== options.category) return false;
        return t.depends_on.every((depId) => taskMap.get(depId)?.status === "done");
      });

      unblockedPending.sort((a, b) => {
        if (options.prefer_task_id) {
          if (a.id === options.prefer_task_id && b.id !== options.prefer_task_id) return -1;
          if (b.id === options.prefer_task_id && a.id !== options.prefer_task_id) return 1;
        }
        const pDiff = PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority];
        if (pDiff !== 0) return pDiff;
        return a.seq_num - b.seq_num;
      });

      const conflictFree: TaskRecord[] = [];
      const skippedDueToLocks: ClaimNextResult["skipped_due_to_file_locks"] = [];

      for (const candidate of unblockedPending) {
        const conflictingFiles: string[] = [];
        const lockingTasks = new Set<string>();
        for (const candidateFile of candidate.affected_files) {
          let fileHasConflict = false;
          for (const activeEntry of activeLockedEntries) {
            if (
              activeEntry.patterns.some((activeFile) =>
                doRepoPathsConflict(candidateFile, activeFile)
              )
            ) {
              fileHasConflict = true;
              lockingTasks.add(activeEntry.taskId);
            }
          }
          if (fileHasConflict) {
            conflictingFiles.push(candidateFile);
          }
        }

        if (conflictingFiles.length > 0 && !options.ignore_file_locks) {
          skippedDueToLocks.push({
            task_id: candidate.id,
            title: candidate.title,
            conflicting_files: conflictingFiles,
            locked_by_task_ids: Array.from(lockingTasks),
          });
        } else {
          conflictFree.push(candidate);
        }
      }

      const activeSummary = activeTasks.map((t) => ({
        id: t.id,
        title: t.title,
        claimed_by: t.claimed_by,
        affected_files: t.affected_files,
        modified_files: t.modified_files,
      }));

      const blockedOrFailed = allTasks
        .filter((t) => t.status === "blocked" || t.status === "failed")
        .map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          blocker_reason: t.blocker_reason,
          attempt_count: t.attempt_count,
        }));

      if (conflictFree.length > 0) {
        const chosen = conflictFree[0]!;
        this.repo.updateTaskRow(projectId, chosen.id, {
          status: "in_progress",
          claimed_by: cleanAgentId,
          claimed_at: nowIso,
          heartbeat_at: nowIso,
          updated_at: nowIso,
        });
        this.repo.recordEvent(projectId, chosen.id, "TASK_CLAIMED", cleanAgentId, {
          priority: chosen.priority,
          ignore_file_locks: options.ignore_file_locks ?? false,
        });

        const claimedTask = this.repo.getTaskById(projectId, chosen.id)!;
        const prerequisiteHandoffs: PrerequisiteHandoff[] = claimedTask.depends_on
          .map((depId) => taskMap.get(depId))
          .filter((t): t is TaskRecord => t !== undefined)
          .map((t) => ({
            task_id: t.id,
            title: t.title,
            status: t.status,
            handoff_notes: t.handoff_notes,
            modified_files: t.modified_files,
            verification_note: t.verification_note,
          }));

        return {
          outcome: "TASK_CLAIMED",
          task: claimedTask,
          project_shared_context: project.shared_context,
          prerequisite_handoffs: prerequisiteHandoffs,
          stale_reclaimed_task_ids: staleReclaimedIds,
          stale_failed_task_ids: staleFailedIds,
          skipped_due_to_file_locks: skippedDueToLocks,
          active_tasks: activeSummary,
          blocked_or_failed_tasks: blockedOrFailed,
          message: `Claimed task ${claimedTask.id} ("${claimedTask.title}") for agent "${cleanAgentId}".`,
        };
      }

      // No claimable conflict-free candidate
      if (allTasks.length === 0) {
        return {
          outcome: "NO_TASKS_PLANNED",
          task: null,
          project_shared_context: project.shared_context,
          prerequisite_handoffs: [],
          stale_reclaimed_task_ids: staleReclaimedIds,
          stale_failed_task_ids: staleFailedIds,
          skipped_due_to_file_locks: skippedDueToLocks,
          active_tasks: activeSummary,
          blocked_or_failed_tasks: blockedOrFailed,
          message:
            "No tasks exist in this project yet. Use create_tasks to build the project plan DAG before claiming.",
        };
      }

      const allDone = allTasks.every((t) => t.status === "done");
      if (allDone) {
        return {
          outcome: "PROJECT_COMPLETED",
          task: null,
          project_shared_context: project.shared_context,
          prerequisite_handoffs: [],
          stale_reclaimed_task_ids: staleReclaimedIds,
          stale_failed_task_ids: staleFailedIds,
          skipped_due_to_file_locks: skippedDueToLocks,
          active_tasks: [],
          blocked_or_failed_tasks: [],
          message: `All ${allTasks.length} tasks in "${resolved.config.project_name}" are done! Run final end-to-end sanity check if needed.`,
        };
      }

      if (activeTasks.length > 0 || skippedDueToLocks.length > 0) {
        return {
          outcome: "WAITING_ON_ACTIVE_TASKS",
          task: null,
          project_shared_context: project.shared_context,
          prerequisite_handoffs: [],
          stale_reclaimed_task_ids: staleReclaimedIds,
          stale_failed_task_ids: staleFailedIds,
          skipped_due_to_file_locks: skippedDueToLocks,
          active_tasks: activeSummary,
          blocked_or_failed_tasks: blockedOrFailed,
          message:
            skippedDueToLocks.length > 0
              ? `Pending tasks are temporarily skipped because their affected_files overlap with active in_progress tasks (${activeSummary
                  .map((a) => a.id)
                  .join(", ")}).`
              : `No unblocked pending tasks available right now; waiting on ${activeTasks.length} active in_progress task(s).`,
        };
      }

      if (blockedOrFailed.length === 0 && options.category) {
        return {
          outcome: "WAITING_ON_ACTIVE_TASKS",
          task: null,
          project_shared_context: project.shared_context,
          prerequisite_handoffs: [],
          stale_reclaimed_task_ids: staleReclaimedIds,
          stale_failed_task_ids: staleFailedIds,
          skipped_due_to_file_locks: skippedDueToLocks,
          active_tasks: activeSummary,
          blocked_or_failed_tasks: blockedOrFailed,
          message: `No actionable pending tasks match category "${options.category}" right now; pending prerequisite/sibling tasks remain in other categories.`,
        };
      }

      return {
        outcome: "BLOCKED_BY_FAILURES",
        task: null,
        project_shared_context: project.shared_context,
        prerequisite_handoffs: [],
        stale_reclaimed_task_ids: staleReclaimedIds,
        stale_failed_task_ids: staleFailedIds,
        skipped_due_to_file_locks: skippedDueToLocks,
        active_tasks: activeSummary,
        blocked_or_failed_tasks: blockedOrFailed,
        message:
          blockedOrFailed.length > 0
            ? `Queue is stalled by ${blockedOrFailed.length} blocked/failed task(s). Resolve or reset them via update_task(reset_to_pending=true) before continuing.`
            : "Queue is stalled: pending tasks have unsatisfied or broken dependencies.",
      };
    });
  }

  public updateTask(
    projectPath: string | undefined,
    taskId: string,
    patch: UpdateTaskPatch,
    actor?: string,
    configFileName?: string
  ): TaskRecord {
    const explicitActor = actor?.trim();
    const effectiveActor = explicitActor || "agent";

    return this.repo.withTransaction(() => {
      const { resolved } = this.resolveAndSync(projectPath, configFileName);
      const projectId = resolved.config.project_id;
      const existing = this.repo.getTaskById(projectId, taskId);
      if (!existing) {
        throw new TasklistError(
          "TASK_NOT_FOUND",
          `Task "${taskId}" not found in project "${resolved.config.project_name}".`
        );
      }

      if (
        !patch.reset_to_pending &&
        existing.status === "in_progress" &&
        existing.claimed_by &&
        explicitActor &&
        existing.claimed_by !== explicitActor
      ) {
        throw new TasklistError(
          "TASK_LOCKED",
          `Task "${taskId}" is currently claimed by "${existing.claimed_by}", not "${explicitActor}". Pass reset_to_pending=true only if intentionally overriding a stuck claim.`
        );
      }

      const now = new Date().toISOString();
      const updateFields: Parameters<TaskRepository["updateTaskRow"]>[2] = {
        updated_at: now,
      };

      if (patch.title !== undefined) {
        const cleanTitle = patch.title.trim();
        if (!cleanTitle) {
          throw new TasklistError("VALIDATION_ERROR", "Task title cannot be empty.");
        }
        updateFields.title = cleanTitle;
      }
      if (patch.description !== undefined) {
        updateFields.description = patch.description.trim();
      }
      if (patch.category !== undefined) {
        updateFields.category = patch.category.trim() || "general";
      }
      if (patch.priority !== undefined) {
        updateFields.priority = patch.priority;
      }
      if (patch.acceptance_criteria !== undefined) {
        updateFields.acceptance_criteria = patch.acceptance_criteria
          .map((c) => c.trim())
          .filter(Boolean);
      }
      if (patch.verification_command !== undefined) {
        updateFields.verification_command =
          patch.verification_command === null
            ? null
            : patch.verification_command.trim() || null;
      }
      if (patch.affected_files !== undefined) {
        updateFields.affected_files = normalizeRepoPaths(
          resolved.project_root,
          patch.affected_files
        );
      }
      if (patch.modified_files !== undefined) {
        const nextNormalized = normalizeRepoPaths(
          resolved.project_root,
          patch.modified_files
        );
        if (patch.append_modified_files) {
          updateFields.modified_files = Array.from(
            new Set([...existing.modified_files, ...nextNormalized])
          );
        } else {
          updateFields.modified_files = nextNormalized;
        }
      }
      if (patch.handoff_notes !== undefined) {
        updateFields.handoff_notes = patch.handoff_notes.trim();
      }
      if (patch.heartbeat) {
        if (existing.status === "in_progress") {
          updateFields.heartbeat_at = now;
        }
      }
      if (patch.reset_to_pending) {
        updateFields.status = "pending";
        updateFields.claimed_by = null;
        updateFields.claimed_at = null;
        updateFields.heartbeat_at = null;
        updateFields.blocker_reason = "";
        updateFields.completed_at = null;
        if (patch.reset_attempts) {
          updateFields.attempt_count = 0;
        }
      } else if (patch.reset_attempts) {
        updateFields.attempt_count = 0;
      }

      // Dependency graph mutations
      let suspendedByAddedDeps: string[] | null = null;
      if (
        (patch.add_depends_on && patch.add_depends_on.length > 0) ||
        (patch.remove_depends_on && patch.remove_depends_on.length > 0)
      ) {
        const allTasks = this.repo.listTasksByProject(projectId);
        const taskMap = new Map(allTasks.map((t) => [t.id, t]));
        const allTaskIds = new Set(allTasks.map((t) => t.id));
        const removeSet = new Set(patch.remove_depends_on ?? []);
        const addList = patch.add_depends_on ?? [];

        for (const depId of addList) {
          if (!allTaskIds.has(depId)) {
            throw new TasklistError(
              "INVALID_DEPENDENCY",
              `Dependency target "${depId}" does not exist.`
            );
          }
        }

        const unfinishedAddedDeps = addList.filter(
          (depId) => taskMap.get(depId)?.status !== "done"
        );
        if (unfinishedAddedDeps.length > 0 && !patch.reset_to_pending) {
          if (existing.status === "done") {
            throw new TasklistError(
              "INVALID_STATE_TRANSITION",
              `Cannot add unfinished prerequisite(s) (${unfinishedAddedDeps.join(
                ", "
              )}) to already-completed task "${taskId}". Pass reset_to_pending=true to reopen it first.`
            );
          }
          if (existing.status === "in_progress") {
            suspendedByAddedDeps = unfinishedAddedDeps;
          }
        }

        const currentEdges = this.repo.getAllDependencies(projectId);
        const filteredEdges = currentEdges.filter(
          (e) => !(e.task_id === taskId && removeSet.has(e.depends_on_task_id))
        );
        const edgeKeys = new Set(
          filteredEdges.map((e) => `${e.task_id}=>${e.depends_on_task_id}`)
        );
        for (const depId of addList) {
          const k = `${taskId}=>${depId}`;
          if (!edgeKeys.has(k)) {
            edgeKeys.add(k);
            filteredEdges.push({ task_id: taskId, depends_on_task_id: depId });
          }
        }

        validateNoCycles(allTaskIds, filteredEdges);

        for (const depId of removeSet) {
          this.repo.removeDependency(projectId, taskId, depId);
        }
        for (const depId of addList) {
          this.repo.addDependency(projectId, taskId, depId);
        }
      }

      if (suspendedByAddedDeps) {
        const suspendNote = `[Auto-suspended waiting on added prerequisite(s): ${suspendedByAddedDeps.join(
          ", "
        )}]`;
        const baseHandoff = updateFields.handoff_notes ?? existing.handoff_notes;
        updateFields.status = "pending";
        updateFields.claimed_by = null;
        updateFields.claimed_at = null;
        updateFields.heartbeat_at = null;
        updateFields.handoff_notes = baseHandoff
          ? `${baseHandoff}\n${suspendNote}`
          : suspendNote;
      }

      this.repo.updateTaskRow(projectId, taskId, updateFields);
      if (suspendedByAddedDeps) {
        this.repo.recordEvent(
          projectId,
          taskId,
          "TASK_SUSPENDED_BY_PREREQUISITE",
          effectiveActor,
          { prerequisite_ids: suspendedByAddedDeps }
        );
      }
      this.repo.recordEvent(projectId, taskId, "TASK_UPDATED", effectiveActor, {
        reset_to_pending: patch.reset_to_pending ?? false,
        heartbeat: patch.heartbeat ?? false,
      });

      return this.repo.getTaskById(projectId, taskId)!;
    });
  }

  public async completeTask(
    projectPath: string | undefined,
    taskId: string,
    params: CompleteTaskParams,
    configFileName?: string
  ): Promise<CompleteTaskResult> {
    const cleanAgentId = params.agent_id?.trim();
    const actor = cleanAgentId || "agent";

    // Phase 1: Validate preconditions inside immediate transaction (no subprocess yet)
    const preflight = this.repo.withTransaction(() => {
      const { resolved } = this.resolveAndSync(projectPath, configFileName);
      const projectId = resolved.config.project_id;
      const allTasks = this.repo.listTasksByProject(projectId);
      const taskMap = new Map(allTasks.map((t) => [t.id, t]));
      const task = taskMap.get(taskId);

      if (!task) {
        throw new TasklistError(
          "TASK_NOT_FOUND",
          `Task "${taskId}" not found in project "${resolved.config.project_name}".`
        );
      }

      if (task.status !== "in_progress") {
        throw new TasklistError(
          "INVALID_STATE_TRANSITION",
          `Cannot complete task "${taskId}" from status "${task.status}". Only "in_progress" tasks claimed via claim_next_task can be completed.`
        );
      }

      if (task.claimed_by) {
        if (!cleanAgentId || task.claimed_by !== cleanAgentId) {
          throw new TasklistError(
            "TASK_LOCKED",
            `Task "${taskId}" is currently claimed by "${task.claimed_by}", not "${cleanAgentId ?? "(unspecified)"}".`
          );
        }
      }

      const unfinishedDeps = task.depends_on.filter(
        (depId) => taskMap.get(depId)?.status !== "done"
      );
      if (unfinishedDeps.length > 0) {
        throw new TasklistError(
          "INVALID_STATE_TRANSITION",
          `Cannot complete task "${taskId}" because prerequisite task(s) are not done yet: ${unfinishedDeps.join(", ")}.`
        );
      }

      const verificationNote = params.verification_note?.trim() ?? "";
      if (resolved.config.require_verification_note && !verificationNote) {
        throw new TasklistError(
          "VALIDATION_ERROR",
          `Project config requires a non-empty verification_note when completing "${taskId}".`
        );
      }

      const normalizedModified =
        params.modified_files !== undefined
          ? Array.from(
              new Set([
                ...task.modified_files,
                ...normalizeRepoPaths(resolved.project_root, params.modified_files),
              ])
            )
          : task.modified_files;

      this.repo.updateTaskRow(projectId, taskId, {
        heartbeat_at: new Date().toISOString(),
      });

      return {
        resolved,
        task,
        expectedStatus: task.status,
        expectedClaimedBy: task.claimed_by,
        expectedClaimedAt: task.claimed_at,
        verificationNote,
        normalizedModified,
      };
    });

    // Phase 2: Execute Active Verification Gate outside SQLite write lock
    let verification: VerificationResult = {
      passed: true,
      steps: [],
      combined_output: "",
    };

    const shouldRunGate =
      preflight.resolved.config.auto_run_verification && !params.skip_verification_run;

    if (shouldRunGate) {
      verification = await runVerificationGate({
        projectRoot: preflight.resolved.project_root,
        taskCommand: preflight.task.verification_command,
        defaultCommand: preflight.resolved.config.default_verification_command,
        timeoutMs: preflight.resolved.config.verification_timeout_ms,
      });
    }

    // Phase 3: Commit result atomically (never throw VERIFICATION_FAILED inside withTransaction
    // or SQLite will rollback the incremented attempt_count and verification output)
    const outcome = this.repo.withTransaction<
      { kind: "failed"; error: TasklistError } | { kind: "ok"; result: CompleteTaskResult }
    >(() => {
      const projectId = preflight.resolved.config.project_id;
      const allTasksNow = this.repo.listTasksByProject(projectId);
      const taskMapNow = new Map(allTasksNow.map((t) => [t.id, t]));
      const currentTask = taskMapNow.get(taskId);

      if (!currentTask) {
        throw new TasklistError(
          "TASK_NOT_FOUND",
          `Task "${taskId}" was deleted while verification was running.`
        );
      }

      if (currentTask.status !== preflight.expectedStatus) {
        throw new TasklistError(
          "INVALID_STATE_TRANSITION",
          `Task "${taskId}" status changed from "${preflight.expectedStatus}" to "${currentTask.status}" while verification was running (e.g. suspended by an injected prerequisite or unlocked).`
        );
      }

      if (
        currentTask.claimed_by !== preflight.expectedClaimedBy ||
        currentTask.claimed_at !== preflight.expectedClaimedAt
      ) {
        throw new TasklistError(
          "TASK_LOCKED",
          `Task "${taskId}" lock ownership changed while verification was running (expected "${preflight.expectedClaimedBy ?? "none"}", found "${currentTask.claimed_by ?? "none"}").`
        );
      }

      const unfinishedDepsNow = currentTask.depends_on.filter(
        (depId) => taskMapNow.get(depId)?.status !== "done"
      );
      if (unfinishedDepsNow.length > 0) {
        throw new TasklistError(
          "INVALID_STATE_TRANSITION",
          `Task "${taskId}" acquired unfinished prerequisite(s) while verification was running: ${unfinishedDepsNow.join(", ")}.`
        );
      }

      const now = new Date().toISOString();

      if (!verification.passed) {
        const nextAttempts = currentTask.attempt_count + 1;
        const reachedLimit = nextAttempts >= preflight.resolved.config.max_attempts;
        const failReason = `Active verification gate failed (attempt ${nextAttempts}/${preflight.resolved.config.max_attempts}).`;

        this.repo.updateTaskRow(projectId, taskId, {
          status: reachedLimit ? "failed" : currentTask.status,
          attempt_count: nextAttempts,
          last_verification_output: verification.combined_output,
          modified_files: preflight.normalizedModified,
          handoff_notes:
            params.handoff_notes !== undefined
              ? params.handoff_notes.trim()
              : currentTask.handoff_notes,
          claimed_by: reachedLimit ? null : currentTask.claimed_by,
          claimed_at: reachedLimit ? null : currentTask.claimed_at,
          heartbeat_at: reachedLimit ? null : now,
          blocker_reason: reachedLimit ? failReason : currentTask.blocker_reason,
          updated_at: now,
        });

        this.repo.recordEvent(projectId, taskId, "VERIFICATION_FAILED", actor, {
          attempt_count: nextAttempts,
          max_attempts: preflight.resolved.config.max_attempts,
          transitioned_to_failed: reachedLimit,
        });

        return {
          kind: "failed",
          error: new TasklistError(
            "VERIFICATION_FAILED",
            `${failReason}${
              reachedLimit
                ? ' Task transitioned to "failed" — fix root cause and reset via update_task(reset_to_pending=true) before retrying.'
                : ' Task remains active so you can fix the error and re-run complete_task.'
            }\n\n${verification.combined_output}`,
            {
              task_id: taskId,
              attempt_count: nextAttempts,
              max_attempts: preflight.resolved.config.max_attempts,
              status: reachedLimit ? "failed" : currentTask.status,
              verification,
            }
          ),
        };
      }

      this.repo.updateTaskRow(projectId, taskId, {
        status: "done",
        verification_note: preflight.verificationNote,
        last_verification_output: verification.combined_output,
        handoff_notes:
          params.handoff_notes !== undefined
            ? params.handoff_notes.trim()
            : currentTask.handoff_notes,
        modified_files: preflight.normalizedModified,
        claimed_by: null,
        claimed_at: null,
        heartbeat_at: null,
        blocker_reason: "",
        completed_at: now,
        updated_at: now,
      });

      this.repo.recordEvent(projectId, taskId, "TASK_COMPLETED", actor, {
        verification_steps_run: verification.steps.length,
        modified_files_count: preflight.normalizedModified.length,
      });

      const allTasksAfter = this.repo.listTasksByProject(projectId);
      const afterMap = new Map(allTasksAfter.map((t) => [t.id, t]));
      const completedTask = afterMap.get(taskId)!;

      const newlyUnblockedIds = allTasksAfter
        .filter(
          (t) =>
            t.status === "pending" &&
            t.depends_on.includes(taskId) &&
            t.depends_on.every((depId) => afterMap.get(depId)?.status === "done")
        )
        .map((t) => t.id);

      const remainingOpen = allTasksAfter.filter((t) => t.status !== "done").length;

      return {
        kind: "ok",
        result: {
          task: completedTask,
          verification,
          newly_unblocked_task_ids: newlyUnblockedIds,
          remaining_open_tasks: remainingOpen,
        },
      };
    });

    if (outcome.kind === "failed") {
      throw outcome.error;
    }
    return outcome.result;
  }

  public blockOrFailTask(
    projectPath: string | undefined,
    taskId: string,
    params: BlockOrFailParams,
    configFileName?: string
  ): TaskRecord {
    const cleanAgentId = params.agent_id?.trim();
    const actor = cleanAgentId || "agent";
    const reason = params.reason.trim();
    if (!reason) {
      throw new TasklistError(
        "VALIDATION_ERROR",
        "reason cannot be empty when blocking or failing a task."
      );
    }

    return this.repo.withTransaction(() => {
      const { resolved } = this.resolveAndSync(projectPath, configFileName);
      const projectId = resolved.config.project_id;
      const existing = this.repo.getTaskById(projectId, taskId);
      if (!existing) {
        throw new TasklistError(
          "TASK_NOT_FOUND",
          `Task "${taskId}" not found in project "${resolved.config.project_name}".`
        );
      }
      if (existing.status === "done") {
        throw new TasklistError(
          "INVALID_STATE_TRANSITION",
          `Task "${taskId}" is already done. Use update_task(reset_to_pending=true) to reopen it.`
        );
      }
      if (
        existing.status === "in_progress" &&
        existing.claimed_by &&
        cleanAgentId &&
        existing.claimed_by !== cleanAgentId
      ) {
        throw new TasklistError(
          "TASK_LOCKED",
          `Task "${taskId}" is currently claimed by "${existing.claimed_by}", not "${cleanAgentId}".`
        );
      }

      const now = new Date().toISOString();
      const normalizedModified =
        params.modified_files !== undefined
          ? Array.from(
              new Set([
                ...existing.modified_files,
                ...normalizeRepoPaths(resolved.project_root, params.modified_files),
              ])
            )
          : existing.modified_files;

      let nextStatus: TaskStatus;
      let nextAttempts = existing.attempt_count;
      let finalReason = reason;

      if (params.outcome === "blocked") {
        nextStatus = "blocked";
      } else if (params.outcome === "failed") {
        nextAttempts += 1;
        nextStatus = "failed";
      } else {
        // retry_later
        nextAttempts += 1;
        if (nextAttempts >= resolved.config.max_attempts) {
          nextStatus = "failed";
          finalReason = `${reason} (reached max_attempts ${resolved.config.max_attempts})`;
        } else {
          nextStatus = "pending";
        }
      }

      this.repo.updateTaskRow(projectId, taskId, {
        status: nextStatus,
        attempt_count: nextAttempts,
        blocker_reason: finalReason,
        handoff_notes:
          params.handoff_notes !== undefined
            ? params.handoff_notes.trim()
            : existing.handoff_notes,
        modified_files: normalizedModified,
        claimed_by: null,
        claimed_at: null,
        heartbeat_at: null,
        updated_at: now,
      });

      this.repo.recordEvent(projectId, taskId, `TASK_${nextStatus.toUpperCase()}`, actor, {
        requested_outcome: params.outcome,
        reason: finalReason,
        attempt_count: nextAttempts,
      });

      return this.repo.getTaskById(projectId, taskId)!;
    });
  }

  public deleteTask(
    projectPath: string | undefined,
    taskId: string,
    force = false,
    actor = "agent",
    configFileName?: string
  ): { deleted_task_id: string; unlinked_dependents: string[] } {
    return this.repo.withTransaction(() => {
      const { resolved } = this.resolveAndSync(projectPath, configFileName);
      const projectId = resolved.config.project_id;
      const existing = this.repo.getTaskById(projectId, taskId);
      if (!existing) {
        throw new TasklistError(
          "TASK_NOT_FOUND",
          `Task "${taskId}" not found in project "${resolved.config.project_name}".`
        );
      }

      if (existing.status === "in_progress" && !force) {
        throw new TasklistError(
          "TASK_LOCKED",
          `Cannot delete "${taskId}" while it is in_progress (claimed by "${existing.claimed_by ?? "unknown"}"). Pass force=true to override.`
        );
      }

      const dependentIds = this.repo.getDependentTaskIds(projectId, taskId);
      if (dependentIds.length > 0 && !force) {
        throw new TasklistError(
          "INVALID_STATE_TRANSITION",
          `Cannot delete "${taskId}" because task(s) depend on it: ${dependentIds.join(
            ", "
          )}. Pass force=true to delete and unlink dependencies.`,
          { dependent_task_ids: dependentIds }
        );
      }

      this.repo.deleteTaskById(projectId, taskId);
      this.repo.recordEvent(projectId, taskId, "TASK_DELETED", actor, {
        title: existing.title,
        force,
        unlinked_dependents: dependentIds,
      });

      return { deleted_task_id: taskId, unlinked_dependents: dependentIds };
    });
  }

  public unlockTasks(
    projectPath: string | undefined,
    options: { taskId?: string; allStale?: boolean; actor?: string; configFileName?: string }
  ): { unlocked_task_ids: string[] } {
    const actor = options.actor?.trim() || "cli";
    return this.repo.withTransaction(() => {
      const { resolved } = this.resolveAndSync(projectPath, options.configFileName);
      const projectId = resolved.config.project_id;
      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();
      const allTasks = this.repo.listTasksByProject(projectId);
      const unlocked: string[] = [];

      if (options.taskId) {
        const target = allTasks.find((t) => t.id === options.taskId);
        if (!target) {
          throw new TasklistError(
            "TASK_NOT_FOUND",
            `Task "${options.taskId}" not found in project "${resolved.config.project_name}".`
          );
        }
        if (target.status === "done") {
          throw new TasklistError(
            "INVALID_STATE_TRANSITION",
            `Task "${target.id}" is already done.`
          );
        }
        this.repo.updateTaskRow(projectId, target.id, {
          status: "pending",
          claimed_by: null,
          claimed_at: null,
          heartbeat_at: null,
          blocker_reason: "",
          attempt_count: 0,
          updated_at: nowIso,
        });
        this.repo.recordEvent(projectId, target.id, "TASK_CLI_UNLOCKED", actor, {
          previous_status: target.status,
        });
        unlocked.push(target.id);
        return { unlocked_task_ids: unlocked };
      }

      for (const task of allTasks) {
        const shouldUnlock = options.allStale
          ? isTaskStale(task, resolved.config.lease_timeout_minutes, nowMs)
          : task.status === "in_progress";

        if (shouldUnlock) {
          this.repo.updateTaskRow(projectId, task.id, {
            status: "pending",
            claimed_by: null,
            claimed_at: null,
            heartbeat_at: null,
            updated_at: nowIso,
          });
          this.repo.recordEvent(projectId, task.id, "TASK_CLI_UNLOCKED", actor, {
            previous_owner: task.claimed_by,
            all_stale: options.allStale ?? false,
          });
          unlocked.push(task.id);
        }
      }

      return { unlocked_task_ids: unlocked };
    });
  }

  public getProjectSummary(
    projectPath: string | undefined,
    configFileName?: string
  ): ProjectSummaryResult {
    return this.repo.withTransaction(() => {
      const { resolved, project } = this.resolveAndSync(projectPath, configFileName);
      const tasks = this.repo.listTasksByProject(resolved.config.project_id);
      const taskMap = new Map(tasks.map((t) => [t.id, t]));
      const nowMs = Date.now();

      const counts: ProjectSummaryResult["counts"] = {
        total: tasks.length,
        pending: 0,
        in_progress: 0,
        done: 0,
        blocked: 0,
        failed: 0,
        actionable: 0,
      };

      const actionableIds: string[] = [];
      const activeTasks: ProjectSummaryResult["active_tasks"] = [];
      const blockedOrFailed: ProjectSummaryResult["blocked_or_failed_tasks"] = [];

      for (const t of tasks) {
        counts[t.status] += 1;
        if (
          t.status === "pending" &&
          t.depends_on.every((depId) => taskMap.get(depId)?.status === "done")
        ) {
          counts.actionable += 1;
          actionableIds.push(t.id);
        }
        if (t.status === "in_progress") {
          activeTasks.push({
            id: t.id,
            title: t.title,
            claimed_by: t.claimed_by,
            claimed_at: t.claimed_at,
            heartbeat_at: t.heartbeat_at,
            is_stale: isTaskStale(t, resolved.config.lease_timeout_minutes, nowMs),
            affected_files: t.affected_files,
          });
        }
        if (t.status === "blocked" || t.status === "failed") {
          blockedOrFailed.push({
            id: t.id,
            title: t.title,
            status: t.status,
            attempt_count: t.attempt_count,
            blocker_reason: t.blocker_reason,
          });
        }
      }

      const completionPercentage =
        counts.total === 0 ? 0 : Math.round((counts.done / counts.total) * 100);

      return {
        project,
        config: resolved.config,
        counts,
        completion_percentage: completionPercentage,
        actionable_task_ids: actionableIds,
        active_tasks: activeTasks,
        blocked_or_failed_tasks: blockedOrFailed,
        execution_waves: computeTopologicalWaves(tasks),
      };
    });
  }
}
