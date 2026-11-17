import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Resolves the centralized SQLite database path:
 * 1. MOEX_DB_PATH (or legacy MCP_TASKLIST_DB_PATH)
 * 2. $XDG_DATA_HOME/moex/tasklist.db
 * 3. ~/.local/share/moex/tasklist.db
 */
export function resolveCentralDbPath(): string {
  const explicit =
    process.env.MOEX_DB_PATH?.trim() ||
    process.env.MCP_TASKLIST_DB_PATH?.trim();
  if (explicit) {
    if (explicit === ":memory:") return ":memory:";
    return path.resolve(explicit);
  }
  const xdgData = process.env.XDG_DATA_HOME?.trim();
  const baseDir =
    xdgData && path.isAbsolute(xdgData)
      ? xdgData
      : path.join(os.homedir(), ".local", "share");
  return path.join(baseDir, "moex", "tasklist.db");
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,
  project_name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  config_path TEXT NOT NULL,
  shared_context TEXT NOT NULL DEFAULT '{}',
  last_seq_num INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  seq_num INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'general',
  status TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'done', 'blocked', 'failed')),
  priority TEXT NOT NULL CHECK (priority IN ('critical', 'high', 'medium', 'low')),
  acceptance_criteria TEXT NOT NULL DEFAULT '[]',
  verification_command TEXT,
  affected_files TEXT NOT NULL DEFAULT '[]',
  modified_files TEXT NOT NULL DEFAULT '[]',
  handoff_notes TEXT NOT NULL DEFAULT '',
  verification_note TEXT NOT NULL DEFAULT '',
  last_verification_output TEXT NOT NULL DEFAULT '',
  claimed_by TEXT,
  claimed_at TEXT,
  heartbeat_at TEXT,
  lock_version INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  blocker_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, seq_num)
);

CREATE INDEX IF NOT EXISTS idx_tasks_project_status
  ON tasks(project_id, status, seq_num);

CREATE TABLE IF NOT EXISTS task_dependencies (
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  depends_on_task_id TEXT NOT NULL,
  PRIMARY KEY (project_id, task_id, depends_on_task_id),
  FOREIGN KEY (project_id, task_id)
    REFERENCES tasks(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, depends_on_task_id)
    REFERENCES tasks(project_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_task_deps_depends_on
  ON task_dependencies(project_id, depends_on_task_id);

CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  task_id TEXT,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'system',
  details TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_events_project_task
  ON task_events(project_id, task_id, id);
`;

export const CURRENT_SCHEMA_VERSION = 3;

export class DatabaseManager {
  public readonly dbPath: string;
  public readonly db: Database;
  private txDepth = 0;
  private savepointSeq = 0;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? resolveCentralDbPath();
    if (this.dbPath !== ":memory:") {
      mkdirSync(path.dirname(this.dbPath), { recursive: true });
    }
    this.db = new Database(this.dbPath, { create: true, strict: true });
    try {
      this.configureAndMigrate();
    } catch (err) {
      try {
        this.db.close();
      } catch {
        // ignore close error on failed init
      }
      throw err;
    }
  }

  public getSchemaVersion(): number {
    const row = this.db
      .query<{ user_version: number }, []>("PRAGMA user_version;")
      .get();
    return row?.user_version ?? 0;
  }

  private configureAndMigrate(): void {
    // Set busy_timeout before WAL pragma so concurrent DB creation waits cleanly
    this.db.exec("PRAGMA busy_timeout = 5000;");
    if (this.dbPath !== ":memory:") {
      this.db.exec("PRAGMA journal_mode = WAL;");
    }
    this.db.exec("PRAGMA foreign_keys = ON;");

    const currentVersion = this.getSchemaVersion();
    if (currentVersion >= CURRENT_SCHEMA_VERSION) {
      return;
    }

    this.withImmediateTransaction(() => {
      const versionInTx = this.getSchemaVersion();

      if (versionInTx < 1) {
        this.db.exec(SCHEMA_SQL);
        this.db.exec("PRAGMA user_version = 1;");
      }

      if (versionInTx < 2) {
        this.ensureProjectSequenceColumn();
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_task_events_project_id
            ON task_events(project_id, id DESC);
        `);
        this.db.exec("PRAGMA user_version = 2;");
      }

      if (versionInTx < 3) {
        this.ensureTaskLockVersionColumn();
        this.db.exec("PRAGMA user_version = 3;");
      }
    });
  }

  /**
   * Ensures existing databases created prior to monotonic sequence tracking
   * receive the projects.last_seq_num column and always backfill their high-water mark.
   */
  private ensureProjectSequenceColumn(): void {
    const columns = this.db
      .query<{ name: string }, []>("PRAGMA table_info(projects)")
      .all();
    const hasLastSeqNum = columns.some((c) => c.name === "last_seq_num");
    if (!hasLastSeqNum) {
      this.db.exec(
        "ALTER TABLE projects ADD COLUMN last_seq_num INTEGER NOT NULL DEFAULT 0;"
      );
    }
    this.db.exec(`
      UPDATE projects
      SET last_seq_num = MAX(
        COALESCE(last_seq_num, 0),
        COALESCE((SELECT MAX(seq_num) FROM tasks WHERE tasks.project_id = projects.project_id), 0),
        COALESCE(
          (SELECT MAX(CAST(SUBSTR(task_id, 6) AS INTEGER))
           FROM task_events
           WHERE task_events.project_id = projects.project_id
             AND task_id GLOB 'TASK-[0-9]*'
             AND SUBSTR(task_id, 6) NOT GLOB '*[^0-9]*'),
          0
        )
      );
    `);
  }

  private ensureTaskLockVersionColumn(): void {
    const columns = this.db
      .query<{ name: string }, []>("PRAGMA table_info(tasks)")
      .all();
    if (!columns.some((c) => c.name === "lock_version")) {
      this.db.exec(
        "ALTER TABLE tasks ADD COLUMN lock_version INTEGER NOT NULL DEFAULT 0;"
      );
    }
  }

  private runInTransaction<T>(beginSql: string, fn: () => T): T {
    if (this.txDepth > 0) {
      const sp = `moex_sp_${++this.savepointSeq}`;
      this.db.exec(`SAVEPOINT ${sp};`);
      this.txDepth += 1;
      try {
        const result = fn();
        this.db.exec(`RELEASE SAVEPOINT ${sp};`);
        return result;
      } catch (err) {
        try {
          this.db.exec(`ROLLBACK TO SAVEPOINT ${sp};`);
          this.db.exec(`RELEASE SAVEPOINT ${sp};`);
        } catch {
          // ignore savepoint rollback error
        }
        throw err;
      } finally {
        this.txDepth -= 1;
      }
    }

    this.db.exec(beginSql);
    this.txDepth += 1;
    try {
      const result = fn();
      this.db.exec("COMMIT;");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {
        // ignore rollback error if transaction already closed
      }
      throw err;
    } finally {
      this.txDepth -= 1;
    }
  }

  /**
   * Executes fn inside a SQLite BEGIN IMMEDIATE transaction so concurrent
   * processes/subagents serialize cleanly on write locks without SQLITE_BUSY races.
   */
  public withImmediateTransaction<T>(fn: () => T): T {
    return this.runInTransaction("BEGIN IMMEDIATE;", fn);
  }

  /**
   * Executes fn inside a read-consistent deferred snapshot transaction
   * so read-only calls do not block concurrent WAL writers.
   */
  public withReadTransaction<T>(fn: () => T): T {
    return this.runInTransaction("BEGIN DEFERRED;", fn);
  }

  public close(): void {
    this.db.close();
  }
}
