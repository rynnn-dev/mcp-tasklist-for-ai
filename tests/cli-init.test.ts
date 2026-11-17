import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ensureGitignoreEntry,
  initProjectConfig,
  normalizeRepoPaths,
  resolveProjectConfig,
} from "../src/config/project-config.ts";
import { TaskScheduler } from "../src/domain/scheduler.ts";
import { DatabaseManager } from "../src/storage/database.ts";
import { TaskRepository } from "../src/storage/task-repository.ts";
import { TasklistError } from "../src/types.ts";

let tempRoot = "";
let prevDbEnv: string | undefined;

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), "moex-cli-test-"));
  prevDbEnv = process.env.MOEX_DB_PATH;
  process.env.MOEX_DB_PATH = path.join(tempRoot, "central.db");
});

afterEach(() => {
  if (prevDbEnv === undefined) {
    delete process.env.MOEX_DB_PATH;
  } else {
    process.env.MOEX_DB_PATH = prevDbEnv;
  }
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("CLI init & per-project config", () => {
  test("creates .moex.json without creating .gitignore if .gitignore does not exist", () => {
    const projDir = path.join(tempRoot, "proj-no-gitignore");
    mkdirSync(projDir, { recursive: true });

    const res = initProjectConfig({ dir: projDir, projectName: "alpha" });
    expect(res.config.project_name).toBe("alpha");
    expect(res.config.project_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(existsSync(path.join(projDir, ".moex.json"))).toBe(true);
    expect(res.gitignore_existed).toBe(false);
    expect(res.gitignore_updated).toBe(false);
    expect(existsSync(path.join(projDir, ".gitignore"))).toBe(false);
  });

  test("appends .moex.json idempotently when .gitignore already exists", () => {
    const projDir = path.join(tempRoot, "proj-with-gitignore");
    mkdirSync(projDir, { recursive: true });
    const gitignorePath = path.join(projDir, ".gitignore");
    writeFileSync(gitignorePath, "node_modules/\ndist/", "utf8");

    const res = initProjectConfig({ dir: projDir });
    expect(res.gitignore_existed).toBe(true);
    expect(res.gitignore_updated).toBe(true);
    expect(readFileSync(gitignorePath, "utf8")).toBe(
      "node_modules/\ndist/\n.moex.json\n"
    );

    const second = ensureGitignoreEntry(projDir, ".moex.json");
    expect(second.gitignore_existed).toBe(true);
    expect(second.gitignore_updated).toBe(false);
    expect(readFileSync(gitignorePath, "utf8")).toBe(
      "node_modules/\ndist/\n.moex.json\n"
    );
  });

  test("rejects re-init without --new or --force, supports --force preserving id and --new rotating id", () => {
    const projDir = path.join(tempRoot, "proj-reinit");
    mkdirSync(projDir, { recursive: true });

    const first = initProjectConfig({
      dir: projDir,
      projectName: "v1",
      maxAttempts: 2,
    });

    expect(() => initProjectConfig({ dir: projDir })).toThrow(TasklistError);

    try {
      initProjectConfig({ dir: projDir });
    } catch (err) {
      expect(err).toBeInstanceOf(TasklistError);
      expect((err as TasklistError).code).toBe("PROJECT_ALREADY_INITIALIZED");
    }

    const forced = initProjectConfig({
      dir: projDir,
      force: true,
      defaultVerificationCommand: "bun test",
      maxAttempts: 5,
    });
    expect(forced.config.project_id).toBe(first.config.project_id);
    expect(forced.config.default_verification_command).toBe("bun test");
    expect(forced.config.max_attempts).toBe(5);

    const rotated = initProjectConfig({ dir: projDir, newProject: true });
    expect(rotated.config.project_id).not.toBe(first.config.project_id);
    expect(rotated.previous_project_id).toBe(first.config.project_id);
  });

  test("upward traversal resolves from nested subdir and stops at uninitialized .git root", () => {
    const outerWorkspace = path.join(tempRoot, "outer");
    const innerGitRepo = path.join(outerWorkspace, "inner-repo");
    const innerSubdir = path.join(innerGitRepo, "src", "components");

    mkdirSync(path.join(innerGitRepo, ".git"), { recursive: true });
    mkdirSync(innerSubdir, { recursive: true });
    initProjectConfig({ dir: outerWorkspace, projectName: "outer" });

    // Must NOT escape inner .git repo to match outerWorkspace/.moex.json
    expect(() => resolveProjectConfig(innerSubdir)).toThrow(TasklistError);
    try {
      resolveProjectConfig(innerSubdir);
    } catch (err) {
      expect((err as TasklistError).code).toBe("PROJECT_NOT_INITIALIZED");
    }

    // Once inner repo is initialized, resolving from deep subdir finds inner repo config
    const innerInit = initProjectConfig({ dir: innerGitRepo, projectName: "inner" });
    const resolved = resolveProjectConfig(innerSubdir);
    expect(resolved.config.project_id).toBe(innerInit.config.project_id);
    expect(resolved.project_root).toBe(innerGitRepo);
  });

  test("CLI subprocess --version, init, status, and unlock execute cleanly against central SQLite DB", () => {
    const projDir = path.join(tempRoot, "cli-e2e-proj");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(path.join(projDir, ".gitignore"), "dist/\n", "utf8");

    const entrypoint = path.resolve(import.meta.dir, "../src/index.ts");

    const verProc = Bun.spawnSync({
      cmd: ["bun", "run", entrypoint, "--version"],
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(verProc.exitCode).toBe(0);
    expect(verProc.stdout.toString().trim()).toBe("moex v1.0.0");

    const initProc = Bun.spawnSync({
      cmd: [
        "bun",
        "run",
        entrypoint,
        "init",
        "--dir",
        projDir,
        "--name",
        "cli-e2e",
        "--verify-cmd",
        "echo ok",
        "--max-attempts",
        "4",
      ],
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(initProc.exitCode).toBe(0);
    const stdout = initProc.stdout.toString();
    expect(stdout).toContain("Initialized moex project:");
    expect(stdout).toContain("project_name : cli-e2e");
    expect(stdout).toContain('added ".moex.json"');

    const dbManager = new DatabaseManager();
    const repo = new TaskRepository(dbManager);
    const resolved = resolveProjectConfig(projDir);
    const projectRow = repo.getProject(resolved.config.project_id);
    expect(projectRow.project_name).toBe("cli-e2e");
    expect(resolved.config.default_verification_command).toBe("echo ok");
    expect(resolved.config.max_attempts).toBe(4);

    // Create & claim TASK-1, then exercise real `moex unlock` validations and modes
    const scheduler = new TaskScheduler(repo);
    scheduler.createTasksBatch(projDir, [{ title: "Locked task via CLI" }]);
    scheduler.claimNextTask(projDir, "cli-test-worker");
    dbManager.close();

    // Missing explicit mode or empty --task must fail cleanly
    const unlockNoMode = Bun.spawnSync({
      cmd: ["bun", "run", entrypoint, "unlock", "--dir", projDir],
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(unlockNoMode.exitCode).toBe(1);

    const unlockEmptyTask = Bun.spawnSync({
      cmd: ["bun", "run", entrypoint, "unlock", "--dir", projDir, "--task", ""],
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(unlockEmptyTask.exitCode).toBe(1);

    const unlockAllProc = Bun.spawnSync({
      cmd: ["bun", "run", entrypoint, "unlock", "--dir", projDir, "--all", "--json"],
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(unlockAllProc.exitCode).toBe(0);
    expect(JSON.parse(unlockAllProc.stdout.toString())).toEqual({
      unlocked_task_ids: ["TASK-1"],
    });

    const statusProc = Bun.spawnSync({
      cmd: ["bun", "run", entrypoint, "status", "--dir", projDir, "--json"],
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(statusProc.exitCode).toBe(0);
    const parsedStatus = JSON.parse(statusProc.stdout.toString());
    expect(parsedStatus.project.project_name).toBe("cli-e2e");
    expect(parsedStatus.counts.total).toBe(1);
    expect(parsedStatus.counts.pending).toBe(1);
  });

  test("normalizeRepoPaths rejects symlinks pointing outside project root", () => {
    const projDir = path.join(tempRoot, "symlink-proj");
    const outsideDir = path.join(tempRoot, "outside-secret");
    mkdirSync(path.join(projDir, "src"), { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(path.join(outsideDir, "secret.txt"), "top-secret", "utf8");

    symlinkSync(outsideDir, path.join(projDir, "src", "leak-link"), "dir");

    expect(() =>
      normalizeRepoPaths(projDir, ["src/leak-link/secret.txt"])
    ).toThrow(TasklistError);

    expect(() =>
      normalizeRepoPaths(projDir, ["src/leak-link/new-child.ts"])
    ).toThrow(TasklistError);

    expect(normalizeRepoPaths(projDir, ["./src/valid.ts"])).toEqual([
      "src/valid.ts",
    ]);
  });

  test("DatabaseManager tracks PRAGMA user_version v3 and CLI show, logs, and projects --prune work end-to-end", () => {
    const projA = path.join(tempRoot, "cli-obs-a");
    const projB = path.join(tempRoot, "cli-obs-b");
    mkdirSync(projA, { recursive: true });
    mkdirSync(projB, { recursive: true });

    const entrypoint = path.resolve(import.meta.dir, "../src/index.ts");

    const initA = Bun.spawnSync({
      cmd: ["bun", "run", entrypoint, "init", "--dir", projA, "--name", "obs-a"],
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(initA.exitCode).toBe(0);

    const initB = Bun.spawnSync({
      cmd: ["bun", "run", entrypoint, "init", "--dir", projB, "--name", "obs-b"],
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(initB.exitCode).toBe(0);

    const dbManager = new DatabaseManager();
    expect(dbManager.getSchemaVersion()).toBe(3);
    const resolvedA = resolveProjectConfig(projA);
    const scheduler = new TaskScheduler(new TaskRepository(dbManager));
    scheduler.createTasksBatch(projA, [
      {
        title: "Inspectable task",
        description: "Detailed task body",
        acceptance_criteria: ["criterion-a"],
        verification_command: "echo verified",
        priority: "high",
      },
    ]);
    dbManager.close();

    const showJsonProc = Bun.spawnSync({
      cmd: ["bun", "run", entrypoint, "show", "TASK-1", "--dir", projA, "--json"],
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(showJsonProc.exitCode).toBe(0);
    const showJson = JSON.parse(showJsonProc.stdout.toString());
    expect(showJson.task.id).toBe("TASK-1");
    expect(showJson.task.title).toBe("Inspectable task");

    const showTextProc = Bun.spawnSync({
      cmd: ["bun", "run", entrypoint, "show", "TASK-1", "--dir", projA],
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(showTextProc.exitCode).toBe(0);
    const showText = showTextProc.stdout.toString();
    expect(showText).toContain("description: Detailed task body");
    expect(showText).toContain("verify_cmd : echo verified");
    expect(showText).toContain("criterion-a");
    expect(showText).toContain("events (");

    const logsBadLimit = Bun.spawnSync({
      cmd: ["bun", "run", entrypoint, "logs", "--dir", projA, "--limit", "0"],
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(logsBadLimit.exitCode).toBe(1);

    const logsProc = Bun.spawnSync({
      cmd: ["bun", "run", entrypoint, "logs", "--dir", projA, "--limit", "10", "--json"],
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(logsProc.exitCode).toBe(0);
    const logsJson = JSON.parse(logsProc.stdout.toString());
    expect(logsJson.project.project_id).toBe(resolvedA.config.project_id);
    expect(logsJson.events.length).toBeGreaterThanOrEqual(1);

    // Delete projB directory so it becomes orphaned, then prune via `moex projects --prune`
    rmSync(projB, { recursive: true, force: true });
    const pruneProc = Bun.spawnSync({
      cmd: ["bun", "run", entrypoint, "projects", "--prune", "--json"],
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(pruneProc.exitCode).toBe(0);
    const pruneJson = JSON.parse(pruneProc.stdout.toString());
    expect(pruneJson.removed_projects.length).toBe(1);
    expect(pruneJson.removed_projects[0].project_name).toBe("obs-b");
    expect(pruneJson.remaining_count).toBe(1);
  });

  test("compiled native binary via install.sh --host-build ignores target repo .env", () => {
    const repoRoot = path.resolve(import.meta.dir, "..");
    const binDir = path.join(tempRoot, "compiled-bin");
    const targetProj = path.join(tempRoot, "dotenv-poisoned-proj");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(targetProj, { recursive: true });

    // Poisoned .env inside target project root (must NOT be autoloaded by compiled moex binary)
    writeFileSync(
      path.join(targetProj, ".env"),
      "MOEX_DB_PATH=/dev/null/impossible/corrupt.db\nMOEX_CONFIG=../../escape.json\n",
      "utf8"
    );

    const installProc = Bun.spawnSync({
      cmd: ["bash", "./scripts/install.sh", "--host-build", "--bin-dir", binDir],
      cwd: repoRoot,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(installProc.exitCode).toBe(0);

    const binaryPath = path.join(binDir, "moex");
    expect(existsSync(binaryPath)).toBe(true);

    const initProc = Bun.spawnSync({
      cmd: [binaryPath, "init", "--name", "dotenv-safe"],
      cwd: targetProj,
      env: {
        ...process.env,
        MOEX_DB_PATH: path.join(tempRoot, "compiled-central.db"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(initProc.exitCode).toBe(0);
    expect(existsSync(path.join(targetProj, ".moex.json"))).toBe(true);

    const statusProc = Bun.spawnSync({
      cmd: [binaryPath, "status", "--json"],
      cwd: targetProj,
      env: {
        ...process.env,
        MOEX_DB_PATH: path.join(tempRoot, "compiled-central.db"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(statusProc.exitCode).toBe(0);
    const statusJson = JSON.parse(statusProc.stdout.toString());
    expect(statusJson.project.project_name).toBe("dotenv-safe");
  }, 20000);

  test("migrates legacy v0 SQLite DB to v3 (backfilling last_seq_num and tasks.lock_version) and enforces init validation", () => {
    const legacyDbPath = path.join(tempRoot, "legacy-v0.db");
    const legacyProj = path.join(tempRoot, "legacy-proj");
    mkdirSync(legacyProj, { recursive: true });
    const init = initProjectConfig({ dir: legacyProj, projectName: "legacy-proj" });
    const projectId = init.config.project_id;

    // Construct an authentic pre-migration v0 DB (no last_seq_num, no lock_version, user_version=0)
    const raw = new Database(legacyDbPath, { create: true, strict: true });
    raw.exec(`
      CREATE TABLE projects (
        project_id TEXT PRIMARY KEY,
        project_name TEXT NOT NULL,
        root_path TEXT NOT NULL,
        config_path TEXT NOT NULL,
        shared_context TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE tasks (
        project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        seq_num INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT 'general',
        status TEXT NOT NULL,
        priority TEXT NOT NULL,
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
        attempt_count INTEGER NOT NULL DEFAULT 0,
        blocker_reason TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        PRIMARY KEY (project_id, id),
        UNIQUE (project_id, seq_num)
      );
      CREATE TABLE task_dependencies (
        project_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        depends_on_task_id TEXT NOT NULL,
        PRIMARY KEY (project_id, task_id, depends_on_task_id)
      );
      CREATE TABLE task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        task_id TEXT,
        event_type TEXT NOT NULL,
        actor TEXT NOT NULL DEFAULT 'system',
        details TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
    `);
    const now = new Date().toISOString();
    raw
      .query(
        "INSERT INTO projects (project_id, project_name, root_path, config_path, shared_context, created_at, updated_at) VALUES (?, ?, ?, ?, '{}', ?, ?)"
      )
      .run(projectId, "legacy-proj", legacyProj, init.config_path, now, now);
    raw
      .query(
        "INSERT INTO tasks (project_id, id, seq_num, title, status, priority, created_at, updated_at) VALUES (?, ?, ?, ?, 'done', 'medium', ?, ?)"
      )
      .run(projectId, "TASK-2", 2, "Second task", now, now);
    raw
      .query(
        "INSERT INTO tasks (project_id, id, seq_num, title, status, priority, created_at, updated_at) VALUES (?, ?, ?, ?, 'done', 'medium', ?, ?)"
      )
      .run(projectId, "TASK-10", 10, "Tenth task", now, now);
    raw.close();

    const migratedDb = new DatabaseManager(legacyDbPath);
    expect(migratedDb.getSchemaVersion()).toBe(3);

    const projRow = migratedDb.db
      .query<{ last_seq_num: number }, [string]>(
        "SELECT last_seq_num FROM projects WHERE project_id = ?"
      )
      .get(projectId);
    expect(projRow?.last_seq_num).toBe(10);

    const taskRow = migratedDb.db
      .query<{ lock_version: number }, [string, string]>(
        "SELECT lock_version FROM tasks WHERE project_id = ? AND id = ?"
      )
      .get(projectId, "TASK-10");
    expect(taskRow?.lock_version).toBe(0);

    const scheduler = new TaskScheduler(new TaskRepository(migratedDb));
    const nextBatch = scheduler.createTasksBatch(legacyProj, [{ title: "Post-migration task" }]);
    expect(nextBatch.tasks[0]?.id).toBe("TASK-11");
    expect(nextBatch.tasks[0]?.lock_version).toBe(0);
    migratedDb.close();

    // Corrupt config: --force refuses silent UUID rotation, --new succeeds
    writeFileSync(init.config_path, "{broken-json", "utf8");
    expect(() =>
      initProjectConfig({ dir: legacyProj, projectName: "legacy-proj", force: true })
    ).toThrow(TasklistError);

    const resetInit = initProjectConfig({
      dir: legacyProj,
      projectName: "legacy-reborn",
      newProject: true,
    });
    expect(resetInit.config.project_id).not.toBe(projectId);

    // CLI init validates range bounds and rejects empty flags
    const entrypoint = path.resolve(import.meta.dir, "../src/index.ts");
    for (const badArgs of [
      ["init", "--dir", ""],
      ["init", "--dir", legacyProj, "--verify-timeout", "100"],
      ["init", "--dir", legacyProj, "--max-attempts", "0"],
      ["init", "--dir", legacyProj, "--lease-minutes", "2000"],
    ]) {
      const badProc = Bun.spawnSync({
        cmd: ["bun", "run", entrypoint, ...badArgs],
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(badProc.exitCode).toBe(1);
    }
  });
});
