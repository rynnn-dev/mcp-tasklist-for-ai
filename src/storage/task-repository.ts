import type { DatabaseManager } from "./database.ts";
import {
  TasklistError,
  type ProjectRecord,
  type ProjectSharedContext,
  type ResolvedProject,
  type TaskEventRecord,
  type TaskPriority,
  type TaskRecord,
  type TaskStatus,
} from "../types.ts";

interface RawProjectRow {
  project_id: string;
  project_name: string;
  root_path: string;
  config_path: string;
  shared_context: string;
  created_at: string;
  updated_at: string;
}

interface RawTaskRow {
  project_id: string;
  id: string;
  seq_num: number;
  title: string;
  description: string;
  category: string;
  status: TaskStatus;
  priority: TaskPriority;
  acceptance_criteria: string;
  verification_command: string | null;
  affected_files: string;
  modified_files: string;
  handoff_notes: string;
  verification_note: string;
  last_verification_output: string;
  claimed_by: string | null;
  claimed_at: string | null;
  heartbeat_at: string | null;
  lock_version: number;
  attempt_count: number;
  blocker_reason: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface RawEventRow {
  id: number;
  project_id: string;
  task_id: string | null;
  event_type: string;
  actor: string;
  details: string;
  created_at: string;
}

function parseJsonSafe<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export class TaskRepository {
  constructor(private readonly dbManager: DatabaseManager) {}

  public withTransaction<T>(fn: () => T): T {
    return this.dbManager.withImmediateTransaction(fn);
  }

  public withReadTransaction<T>(fn: () => T): T {
    return this.dbManager.withReadTransaction(fn);
  }

  public upsertProject(resolved: ResolvedProject): ProjectRecord {
    const now = new Date().toISOString();
    const { config, project_root, config_path } = resolved;

    const existing = this.dbManager.db
      .query<RawProjectRow, [string]>("SELECT * FROM projects WHERE project_id = ?")
      .get(config.project_id);

    if (!existing) {
      this.dbManager.db
        .query(
          `INSERT INTO projects (
            project_id, project_name, root_path, config_path, shared_context, created_at, updated_at
          ) VALUES (?, ?, ?, ?, '{}', ?, ?)`
        )
        .run(config.project_id, config.project_name, project_root, config_path, now, now);
    } else if (
      existing.project_name !== config.project_name ||
      existing.root_path !== project_root ||
      existing.config_path !== config_path
    ) {
      this.dbManager.db
        .query(
          `UPDATE projects
           SET project_name = ?, root_path = ?, config_path = ?, updated_at = ?
           WHERE project_id = ?`
        )
        .run(config.project_name, project_root, config_path, now, config.project_id);
    }

    return this.getProject(config.project_id);
  }

  public getProject(projectId: string): ProjectRecord {
    const row = this.dbManager.db
      .query<RawProjectRow, [string]>("SELECT * FROM projects WHERE project_id = ?")
      .get(projectId);

    if (!row) {
      throw new TasklistError(
        "PROJECT_NOT_INITIALIZED",
        `Project "${projectId}" is not registered in the database.`
      );
    }

    return {
      project_id: row.project_id,
      project_name: row.project_name,
      root_path: row.root_path,
      config_path: row.config_path,
      shared_context: parseJsonSafe<ProjectSharedContext>(row.shared_context, {}),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  public updateProjectSharedContext(
    projectId: string,
    nextContext: ProjectSharedContext
  ): ProjectRecord {
    const now = new Date().toISOString();
    this.dbManager.db
      .query("UPDATE projects SET shared_context = ?, updated_at = ? WHERE project_id = ?")
      .run(JSON.stringify(nextContext), now, projectId);
    return this.getProject(projectId);
  }

  public getNextSeqNum(projectId: string): number {
    const row = this.dbManager.db
      .query<{ high_water: number }, [string, string, string]>(
        `SELECT MAX(
          COALESCE((SELECT last_seq_num FROM projects WHERE project_id = ?), 0),
          COALESCE((SELECT MAX(seq_num) FROM tasks WHERE project_id = ?), 0),
          COALESCE(
            (SELECT MAX(CAST(SUBSTR(task_id, 6) AS INTEGER))
             FROM task_events
             WHERE project_id = ?
               AND task_id GLOB 'TASK-[0-9]*'
               AND SUBSTR(task_id, 6) NOT GLOB '*[^0-9]*'),
            0
          )
        ) AS high_water`
      )
      .get(projectId, projectId, projectId);
    return (row?.high_water ?? 0) + 1;
  }

  public advanceProjectSeqNum(projectId: string, lastSeqNum: number): void {
    this.dbManager.db
      .query(
        `UPDATE projects
         SET last_seq_num = MAX(last_seq_num, ?)
         WHERE project_id = ?`
      )
      .run(lastSeqNum, projectId);
  }

  public insertTask(task: Omit<TaskRecord, "depends_on">): void {
    this.dbManager.db
      .query(
        `INSERT INTO tasks (
          project_id, id, seq_num, title, description, category, status, priority,
          acceptance_criteria, verification_command, affected_files, modified_files,
          handoff_notes, verification_note, last_verification_output,
          claimed_by, claimed_at, heartbeat_at, lock_version, attempt_count, blocker_reason,
          created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        task.project_id,
        task.id,
        task.seq_num,
        task.title,
        task.description,
        task.category,
        task.status,
        task.priority,
        JSON.stringify(task.acceptance_criteria),
        task.verification_command,
        JSON.stringify(task.affected_files),
        JSON.stringify(task.modified_files),
        task.handoff_notes,
        task.verification_note,
        task.last_verification_output,
        task.claimed_by,
        task.claimed_at,
        task.heartbeat_at,
        task.lock_version,
        task.attempt_count,
        task.blocker_reason,
        task.created_at,
        task.updated_at,
        task.completed_at
      );
  }

  public updateTaskRow(
    projectId: string,
    taskId: string,
    fields: Partial<{
      title: string;
      description: string;
      category: string;
      status: TaskStatus;
      priority: TaskPriority;
      acceptance_criteria: string[];
      verification_command: string | null;
      affected_files: string[];
      modified_files: string[];
      handoff_notes: string;
      verification_note: string;
      last_verification_output: string;
      claimed_by: string | null;
      claimed_at: string | null;
      heartbeat_at: string | null;
      lock_version: number;
      increment_lock_version: boolean;
      attempt_count: number;
      blocker_reason: string;
      updated_at: string;
      completed_at: string | null;
    }>
  ): void {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];

    if (fields.title !== undefined) {
      sets.push("title = ?");
      values.push(fields.title);
    }
    if (fields.description !== undefined) {
      sets.push("description = ?");
      values.push(fields.description);
    }
    if (fields.category !== undefined) {
      sets.push("category = ?");
      values.push(fields.category);
    }
    if (fields.status !== undefined) {
      sets.push("status = ?");
      values.push(fields.status);
    }
    if (fields.priority !== undefined) {
      sets.push("priority = ?");
      values.push(fields.priority);
    }
    if (fields.acceptance_criteria !== undefined) {
      sets.push("acceptance_criteria = ?");
      values.push(JSON.stringify(fields.acceptance_criteria));
    }
    if (fields.verification_command !== undefined) {
      sets.push("verification_command = ?");
      values.push(fields.verification_command);
    }
    if (fields.affected_files !== undefined) {
      sets.push("affected_files = ?");
      values.push(JSON.stringify(fields.affected_files));
    }
    if (fields.modified_files !== undefined) {
      sets.push("modified_files = ?");
      values.push(JSON.stringify(fields.modified_files));
    }
    if (fields.handoff_notes !== undefined) {
      sets.push("handoff_notes = ?");
      values.push(fields.handoff_notes);
    }
    if (fields.verification_note !== undefined) {
      sets.push("verification_note = ?");
      values.push(fields.verification_note);
    }
    if (fields.last_verification_output !== undefined) {
      sets.push("last_verification_output = ?");
      values.push(fields.last_verification_output);
    }
    if (fields.claimed_by !== undefined) {
      sets.push("claimed_by = ?");
      values.push(fields.claimed_by);
    }
    if (fields.claimed_at !== undefined) {
      sets.push("claimed_at = ?");
      values.push(fields.claimed_at);
    }
    if (fields.heartbeat_at !== undefined) {
      sets.push("heartbeat_at = ?");
      values.push(fields.heartbeat_at);
    }
    if (fields.lock_version !== undefined) {
      sets.push("lock_version = ?");
      values.push(fields.lock_version);
    } else if (fields.increment_lock_version) {
      sets.push("lock_version = lock_version + 1");
    }
    if (fields.attempt_count !== undefined) {
      sets.push("attempt_count = ?");
      values.push(fields.attempt_count);
    }
    if (fields.blocker_reason !== undefined) {
      sets.push("blocker_reason = ?");
      values.push(fields.blocker_reason);
    }
    if (fields.completed_at !== undefined) {
      sets.push("completed_at = ?");
      values.push(fields.completed_at);
    }

    sets.push("updated_at = ?");
    values.push(fields.updated_at ?? new Date().toISOString());

    values.push(projectId, taskId);

    this.dbManager.db
      .query(`UPDATE tasks SET ${sets.join(", ")} WHERE project_id = ? AND id = ?`)
      .run(...values);
  }

  public addDependency(projectId: string, taskId: string, dependsOnTaskId: string): void {
    this.dbManager.db
      .query(
        `INSERT OR IGNORE INTO task_dependencies (project_id, task_id, depends_on_task_id)
         VALUES (?, ?, ?)`
      )
      .run(projectId, taskId, dependsOnTaskId);
  }

  public removeDependency(projectId: string, taskId: string, dependsOnTaskId: string): void {
    this.dbManager.db
      .query(
        `DELETE FROM task_dependencies
         WHERE project_id = ? AND task_id = ? AND depends_on_task_id = ?`
      )
      .run(projectId, taskId, dependsOnTaskId);
  }

  public getAllDependencies(
    projectId: string
  ): Array<{ task_id: string; depends_on_task_id: string }> {
    return this.dbManager.db
      .query<{ task_id: string; depends_on_task_id: string }, [string]>(
        `SELECT task_id, depends_on_task_id
         FROM task_dependencies
         WHERE project_id = ?
         ORDER BY task_id, depends_on_task_id`
      )
      .all(projectId);
  }

  public getDependentTaskIds(projectId: string, taskId: string): string[] {
    const rows = this.dbManager.db
      .query<{ task_id: string }, [string, string]>(
        `SELECT task_id
         FROM task_dependencies
         WHERE project_id = ? AND depends_on_task_id = ?`
      )
      .all(projectId, taskId);
    return rows.map((r) => r.task_id);
  }

  public listTasksByProject(projectId: string): TaskRecord[] {
    const rows = this.dbManager.db
      .query<RawTaskRow, [string]>(
        "SELECT * FROM tasks WHERE project_id = ? ORDER BY seq_num ASC"
      )
      .all(projectId);

    const deps = this.getAllDependencies(projectId);
    const depsMap = new Map<string, string[]>();
    for (const d of deps) {
      const list = depsMap.get(d.task_id);
      if (list) {
        list.push(d.depends_on_task_id);
      } else {
        depsMap.set(d.task_id, [d.depends_on_task_id]);
      }
    }

    return rows.map((row) => this.hydrateTask(row, depsMap.get(row.id) ?? []));
  }

  public getTaskById(projectId: string, taskId: string): TaskRecord | null {
    const row = this.dbManager.db
      .query<RawTaskRow, [string, string]>(
        "SELECT * FROM tasks WHERE project_id = ? AND id = ?"
      )
      .get(projectId, taskId);
    if (!row) return null;

    const depRows = this.dbManager.db
      .query<{ depends_on_task_id: string }, [string, string]>(
        `SELECT depends_on_task_id
         FROM task_dependencies
         WHERE project_id = ? AND task_id = ?
         ORDER BY depends_on_task_id`
      )
      .all(projectId, taskId);

    return this.hydrateTask(
      row,
      depRows.map((d) => d.depends_on_task_id)
    );
  }

  public deleteTaskById(projectId: string, taskId: string): void {
    this.dbManager.db
      .query("DELETE FROM tasks WHERE project_id = ? AND id = ?")
      .run(projectId, taskId);
  }

  public recordEvent(
    projectId: string,
    taskId: string | null,
    eventType: string,
    actor: string,
    details: Record<string, unknown> = {}
  ): void {
    const now = new Date().toISOString();
    this.dbManager.db
      .query(
        `INSERT INTO task_events (project_id, task_id, event_type, actor, details, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(projectId, taskId, eventType, actor, JSON.stringify(details), now);
  }

  public listProjects(): ProjectRecord[] {
    const rows = this.dbManager.db
      .query<RawProjectRow, []>(
        "SELECT * FROM projects ORDER BY updated_at DESC, created_at DESC"
      )
      .all();

    return rows.map((row) => ({
      project_id: row.project_id,
      project_name: row.project_name,
      root_path: row.root_path,
      config_path: row.config_path,
      shared_context: parseJsonSafe<ProjectSharedContext>(row.shared_context, {}),
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));
  }

  public deleteProject(projectId: string): void {
    this.dbManager.db
      .query("DELETE FROM projects WHERE project_id = ?")
      .run(projectId);
  }

  public getTaskEvents(
    projectId: string,
    taskId: string,
    limit = 30
  ): TaskEventRecord[] {
    return this.getProjectEvents(projectId, limit, taskId);
  }

  public getProjectEvents(
    projectId: string,
    limit = 30,
    taskId?: string
  ): TaskEventRecord[] {
    if (taskId !== undefined && !taskId.trim()) {
      throw new TasklistError("VALIDATION_ERROR", "task_id filter cannot be empty.");
    }
    const safeLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(Math.trunc(limit), 500))
      : 30;
    const cleanTaskId = taskId?.trim();

    const rows =
      cleanTaskId !== undefined
        ? this.dbManager.db
            .query<RawEventRow, [string, string, number]>(
              `SELECT * FROM task_events
               WHERE project_id = ? AND task_id = ?
               ORDER BY id DESC
               LIMIT ?`
            )
            .all(projectId, cleanTaskId, safeLimit)
        : this.dbManager.db
            .query<RawEventRow, [string, number]>(
              `SELECT * FROM task_events
               WHERE project_id = ?
               ORDER BY id DESC
               LIMIT ?`
            )
            .all(projectId, safeLimit);

    return rows.map((row) => ({
      id: row.id,
      project_id: row.project_id,
      task_id: row.task_id,
      event_type: row.event_type,
      actor: row.actor,
      details: parseJsonSafe<Record<string, unknown>>(row.details, {}),
      created_at: row.created_at,
    }));
  }

  private hydrateTask(row: RawTaskRow, dependsOn: string[]): TaskRecord {
    return {
      project_id: row.project_id,
      id: row.id,
      seq_num: row.seq_num,
      title: row.title,
      description: row.description,
      category: row.category,
      status: row.status,
      priority: row.priority,
      acceptance_criteria: parseJsonSafe<string[]>(row.acceptance_criteria, []),
      verification_command: row.verification_command,
      affected_files: parseJsonSafe<string[]>(row.affected_files, []),
      modified_files: parseJsonSafe<string[]>(row.modified_files, []),
      handoff_notes: row.handoff_notes,
      verification_note: row.verification_note,
      last_verification_output: row.last_verification_output,
      claimed_by: row.claimed_by,
      claimed_at: row.claimed_at,
      heartbeat_at: row.heartbeat_at,
      lock_version: row.lock_version ?? 0,
      attempt_count: row.attempt_count,
      blocker_reason: row.blocker_reason,
      created_at: row.created_at,
      updated_at: row.updated_at,
      completed_at: row.completed_at,
      depends_on: dependsOn,
    };
  }
}
