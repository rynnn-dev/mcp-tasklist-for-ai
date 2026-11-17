import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
    dbManager.close();

    const statusProc = Bun.spawnSync({
      cmd: ["bun", "run", entrypoint, "status", "--dir", projDir, "--json"],
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(statusProc.exitCode).toBe(0);
    const parsedStatus = JSON.parse(statusProc.stdout.toString());
    expect(parsedStatus.project.project_name).toBe("cli-e2e");
    expect(parsedStatus.counts.total).toBe(0);
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
});
