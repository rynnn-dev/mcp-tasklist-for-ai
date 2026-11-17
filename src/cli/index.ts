import path from "node:path";
import { parseArgs } from "node:util";
import {
  DEFAULT_CONFIG_FILENAME,
  initProjectConfig,
} from "../config/project-config.ts";
import { TaskScheduler } from "../domain/scheduler.ts";
import { DatabaseManager } from "../storage/database.ts";
import { TaskRepository } from "../storage/task-repository.ts";
import { TasklistError, MOEX_VERSION } from "../types.ts";

export interface CliResult {
  mode: "cli" | "serve";
  exitCode: number;
  serveOptions?: {
    projectDir?: string;
    configFileName?: string;
  };
}

function printHelp(): void {
  console.log(`moex v${MOEX_VERSION} — Autonomous Whole-Project Tasklist MCP Server & CLI

Usage:
  moex [serve] [--project-dir <path>] [--config <file>]
  moex init [options]
  moex status [--dir <path>] [--config <file>] [--json]
  moex show [<task-id> | --task <id>] [--dir <path>] [--config <file>] [--json]
  moex logs [--dir <path>] [--config <file>] [--task <id>] [--limit <n>] [--json]
  moex projects [--prune] [--json]
  moex unlock [--dir <path>] [--config <file>] (--task <id> | --all-stale | --all) [--json]

Subcommands:
  init      Initialize ${DEFAULT_CONFIG_FILENAME} in a target project root and register it in the central DB.
            Automatically appends the config filename to .gitignore ONLY if .gitignore exists.
  status    Print a human-readable summary of project tasks, active locks, and blockers.
  show      Inspect full detail of a specific task including last verification output and events.
  logs      Show audit event history for the project (or filtered by --task).
  projects  List all registered projects in the central DB (use --prune to remove orphaned entries).
  unlock    Release stuck in_progress locks (--all-stale / --all) or reset a specific task (--task <id>) to pending.
  serve     Start the MCP stdio server (default when no subcommand is given).

Init options:
  --dir <path>              Target project directory (default: current working directory)
  --name <name>             Project display name (default: directory basename)
  --config <file>           Custom config filename (default: ${DEFAULT_CONFIG_FILENAME})
  --verify-cmd <command>    Default verification command run by Active Verification Gate
  --no-auto-verify          Disable automatic verification command execution on complete_task
  --verify-timeout <ms>     Verification command timeout in ms (1000..600000, default: 60000)
  --max-attempts <n>        Max failed/stale attempts before task turns failed (1..20, default: 3)
  --lease-minutes <n>       Lease timeout in minutes for stale recovery (1..1440, default: 30)
  --no-require-note         Do not require verification_note on complete_task
  --new                     Generate a fresh project_id UUID even if config already exists
  --force                   Overwrite/update config settings while preserving existing project_id
  -v, --version             Show version
  -h, --help                Show help
`);
}

function requireNonEmptyFlag(
  raw: string | undefined,
  flagName: string
): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new TasklistError("VALIDATION_ERROR", `Flag ${flagName} cannot be empty.`);
  }
  return trimmed;
}

function parseIntInRange(
  raw: string | undefined,
  flagName: string,
  min: number,
  max: number
): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new TasklistError("VALIDATION_ERROR", `Flag ${flagName} cannot be empty.`);
  }
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new TasklistError(
      "VALIDATION_ERROR",
      `Flag ${flagName} must be an integer between ${min} and ${max}, received "${raw}".`
    );
  }
  return parsed;
}

export function runCliCommand(argv: readonly string[]): CliResult {
  const args = [...argv];
  const first = args[0];

  if (
    args.length === 1 &&
    (first === "-v" || first === "--version" || first === "version")
  ) {
    console.log(`moex v${MOEX_VERSION}`);
    return { mode: "cli", exitCode: 0 };
  }

  if (
    args.length === 1 &&
    (first === "-h" || first === "--help" || first === "help")
  ) {
    printHelp();
    return { mode: "cli", exitCode: 0 };
  }

  // Default or explicit "serve"
  if (!first || first === "serve" || first.startsWith("-")) {
    const serveArgs = first === "serve" ? args.slice(1) : args;
    const parsed = parseArgs({
      args: serveArgs,
      options: {
        "project-dir": { type: "string" },
        config: { type: "string" },
        version: { type: "boolean", short: "v" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    });

    if (parsed.values.version) {
      console.log(`moex v${MOEX_VERSION}`);
      return { mode: "cli", exitCode: 0 };
    }

    if (parsed.values.help) {
      printHelp();
      return { mode: "cli", exitCode: 0 };
    }

    return {
      mode: "serve",
      exitCode: 0,
      serveOptions: {
        projectDir: requireNonEmptyFlag(parsed.values["project-dir"], "--project-dir"),
        configFileName: requireNonEmptyFlag(parsed.values.config, "--config"),
      },
    };
  }

  const subcommand = first;
  const subArgs = args.slice(1);

  if (subcommand === "init") {
    const parsed = parseArgs({
      args: subArgs,
      options: {
        dir: { type: "string" },
        name: { type: "string" },
        config: { type: "string" },
        "verify-cmd": { type: "string" },
        "no-auto-verify": { type: "boolean" },
        "verify-timeout": { type: "string" },
        "max-attempts": { type: "string" },
        "lease-minutes": { type: "string" },
        "no-require-note": { type: "boolean" },
        new: { type: "boolean" },
        force: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    });

    if (parsed.values.help) {
      printHelp();
      return { mode: "cli", exitCode: 0 };
    }

    const rawDir = requireNonEmptyFlag(parsed.values.dir, "--dir");
    const targetDir = rawDir ? path.resolve(rawDir) : process.cwd();
    const result = initProjectConfig({
      dir: targetDir,
      projectName: requireNonEmptyFlag(parsed.values.name, "--name"),
      configFileName: requireNonEmptyFlag(parsed.values.config, "--config"),
      defaultVerificationCommand: parsed.values["verify-cmd"]?.trim(),
      autoRunVerification: parsed.values["no-auto-verify"] ? false : undefined,
      verificationTimeoutMs: parseIntInRange(
        parsed.values["verify-timeout"],
        "--verify-timeout",
        1000,
        600000
      ),
      maxAttempts: parseIntInRange(parsed.values["max-attempts"], "--max-attempts", 1, 20),
      leaseTimeoutMinutes: parseIntInRange(
        parsed.values["lease-minutes"],
        "--lease-minutes",
        1,
        1440
      ),
      requireVerificationNote: parsed.values["no-require-note"] ? false : undefined,
      newProject: parsed.values.new ?? false,
      force: parsed.values.force ?? false,
    });

    const dbManager = new DatabaseManager();
    try {
      const repo = new TaskRepository(dbManager);
      const scheduler = new TaskScheduler(repo);
      scheduler.syncResolvedProject({
        config: result.config,
        project_root: result.project_root,
        config_path: result.config_path,
        config_file_name: result.config_file_name,
      });

      console.log(`Initialized moex project:`);
      console.log(`  project_name : ${result.config.project_name}`);
      console.log(`  project_id   : ${result.config.project_id}`);
      console.log(`  config_path  : ${result.config_path}`);
      console.log(`  central_db   : ${dbManager.dbPath}`);
      if (result.gitignore_existed) {
        console.log(
          `  .gitignore   : ${
            result.gitignore_updated
              ? `added "${result.config_file_name}"`
              : `already contains "${result.config_file_name}"`
          }`
        );
      } else {
        console.log(`  .gitignore   : not present (skipped creating one)`);
      }
    } finally {
      dbManager.close();
    }

    return { mode: "cli", exitCode: 0 };
  }

  if (subcommand === "status") {
    const parsed = parseArgs({
      args: subArgs,
      options: {
        dir: { type: "string" },
        config: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    });

    if (parsed.values.help) {
      printHelp();
      return { mode: "cli", exitCode: 0 };
    }

    const dbManager = new DatabaseManager();
    try {
      const repo = new TaskRepository(dbManager);
      const scheduler = new TaskScheduler(repo);
      const targetDir =
        requireNonEmptyFlag(parsed.values.dir, "--dir") ?? process.cwd();
      const configFileName = requireNonEmptyFlag(parsed.values.config, "--config");
      const summary = scheduler.getProjectSummary(targetDir, configFileName);

      if (parsed.values.json) {
        console.log(JSON.stringify(summary, null, 2));
        return { mode: "cli", exitCode: 0 };
      }

      console.log(
        `Project: ${summary.project.project_name} (${summary.project.project_id})`
      );
      console.log(`Root   : ${summary.project.root_path}`);
      console.log(
        `Progress: ${summary.counts.done}/${summary.counts.total} done (${summary.completion_percentage}%)`
      );
      console.log(
        `Counts  : pending=${summary.counts.pending} (actionable=${summary.counts.actionable}), in_progress=${summary.counts.in_progress}, blocked=${summary.counts.blocked}, failed=${summary.counts.failed}`
      );
      if (summary.actionable_task_ids.length > 0) {
        console.log(`Ready   : ${summary.actionable_task_ids.join(", ")}`);
      }
      if (summary.active_tasks.length > 0) {
        console.log(`Active  :`);
        for (const t of summary.active_tasks) {
          console.log(
            `  - ${t.id} "${t.title}" [claimed_by=${t.claimed_by ?? "-"} stale=${t.is_stale}]`
          );
        }
      }
      if (summary.blocked_or_failed_tasks.length > 0) {
        console.log(`Blockers:`);
        for (const t of summary.blocked_or_failed_tasks) {
          console.log(
            `  - ${t.id} [${t.status}, attempts=${t.attempt_count}] "${t.title}": ${t.blocker_reason}`
          );
        }
      }
    } finally {
      dbManager.close();
    }

    return { mode: "cli", exitCode: 0 };
  }

  if (subcommand === "unlock") {
    const parsed = parseArgs({
      args: subArgs,
      options: {
        dir: { type: "string" },
        config: { type: "string" },
        task: { type: "string" },
        "all-stale": { type: "boolean" },
        all: { type: "boolean" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    });

    if (parsed.values.help) {
      printHelp();
      return { mode: "cli", exitCode: 0 };
    }

    const targetDir =
      requireNonEmptyFlag(parsed.values.dir, "--dir") ?? process.cwd();
    const configFileName = requireNonEmptyFlag(parsed.values.config, "--config");
    const taskId = requireNonEmptyFlag(parsed.values.task, "--task");

    const dbManager = new DatabaseManager();
    try {
      const repo = new TaskRepository(dbManager);
      const scheduler = new TaskScheduler(repo);
      const res = scheduler.unlockTasks(targetDir, {
        taskId,
        allStale: parsed.values["all-stale"] ?? false,
        all: parsed.values.all ?? false,
        configFileName,
      });

      if (parsed.values.json) {
        console.log(JSON.stringify(res, null, 2));
        return { mode: "cli", exitCode: 0 };
      }

      if (res.unlocked_task_ids.length === 0) {
        console.log("No matching locked/stale tasks found to unlock.");
      } else {
        console.log(`Unlocked tasks back to pending: ${res.unlocked_task_ids.join(", ")}`);
      }
    } finally {
      dbManager.close();
    }

    return { mode: "cli", exitCode: 0 };
  }

  if (subcommand === "show") {
    const parsed = parseArgs({
      args: subArgs,
      options: {
        dir: { type: "string" },
        config: { type: "string" },
        task: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: true,
    });

    if (parsed.values.help) {
      printHelp();
      return { mode: "cli", exitCode: 0 };
    }

    if (parsed.positionals.length > 1) {
      throw new TasklistError(
        "VALIDATION_ERROR",
        `Expected at most one <task-id> positional argument, received: ${parsed.positionals.join(", ")}`
      );
    }
    if (parsed.values.task !== undefined && parsed.positionals.length > 0) {
      throw new TasklistError(
        "VALIDATION_ERROR",
        "Specify either positional <task-id> or --task <id>, not both."
      );
    }

    const cleanFlagTask = requireNonEmptyFlag(parsed.values.task, "--task");
    const cleanPositionalTask =
      parsed.positionals[0] !== undefined
        ? requireNonEmptyFlag(parsed.positionals[0], "<task-id>")
        : undefined;
    const taskId = cleanFlagTask ?? cleanPositionalTask;
    if (!taskId) {
      throw new TasklistError(
        "VALIDATION_ERROR",
        'Usage: moex show <task-id> (or --task <id>) [--dir <path>] [--config <file>] [--json]'
      );
    }

    const targetDir =
      requireNonEmptyFlag(parsed.values.dir, "--dir") ?? process.cwd();
    const configFileName = requireNonEmptyFlag(parsed.values.config, "--config");

    const dbManager = new DatabaseManager();
    try {
      const repo = new TaskRepository(dbManager);
      const scheduler = new TaskScheduler(repo);
      const detail = scheduler.getTaskDetail(targetDir, taskId, configFileName);

      if (parsed.values.json) {
        console.log(JSON.stringify(detail, null, 2));
        return { mode: "cli", exitCode: 0 };
      }

      const t = detail.task;
      console.log(`${t.id} [${t.status}] (${t.priority}) — ${t.title}`);
      console.log(`  category   : ${t.category}`);
      console.log(`  claimed_by : ${t.claimed_by ?? "-"}`);
      console.log(`  attempts   : ${t.attempt_count}`);
      if (t.description) {
        console.log(`  description: ${t.description}`);
      }
      if (t.verification_command) {
        console.log(`  verify_cmd : ${t.verification_command}`);
      }
      if (t.acceptance_criteria.length > 0) {
        console.log(`  criteria   :`);
        for (const item of t.acceptance_criteria) {
          console.log(`    - ${item}`);
        }
      }
      if (t.depends_on.length > 0) {
        console.log(`  depends_on : ${t.depends_on.join(", ")}`);
      }
      if (detail.prerequisites.length > 0) {
        console.log(
          `  prereqs    : ${detail.prerequisites
            .map((p) => `${p.id}[${p.status}]`)
            .join(", ")}`
        );
      }
      if (detail.dependents.length > 0) {
        console.log(
          `  dependents : ${detail.dependents
            .map((d) => `${d.id}[${d.status}]`)
            .join(", ")}`
        );
      }
      if (t.affected_files.length > 0) {
        console.log(`  affected   : ${t.affected_files.join(", ")}`);
      }
      if (t.modified_files.length > 0) {
        console.log(`  modified   : ${t.modified_files.join(", ")}`);
      }
      if (t.blocker_reason) {
        console.log(`  blocker    : ${t.blocker_reason}`);
      }
      if (t.handoff_notes) {
        console.log(`  handoff    : ${t.handoff_notes}`);
      }
      if (t.last_verification_output) {
        console.log(`  last_verification_output:\n${t.last_verification_output}`);
      }
      if (detail.events.length > 0) {
        console.log(`  events (${detail.events.length}):`);
        for (const ev of detail.events) {
          console.log(`    - ${ev.created_at} [${ev.event_type}] actor=${ev.actor}`);
        }
      }
    } finally {
      dbManager.close();
    }

    return { mode: "cli", exitCode: 0 };
  }

  if (subcommand === "logs") {
    const parsed = parseArgs({
      args: subArgs,
      options: {
        dir: { type: "string" },
        config: { type: "string" },
        task: { type: "string" },
        limit: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    });

    if (parsed.values.help) {
      printHelp();
      return { mode: "cli", exitCode: 0 };
    }

    const limit = parseIntInRange(parsed.values.limit, "--limit", 1, 500) ?? 30;
    const targetDir =
      requireNonEmptyFlag(parsed.values.dir, "--dir") ?? process.cwd();
    const taskId = requireNonEmptyFlag(parsed.values.task, "--task");
    const configFileName = requireNonEmptyFlag(parsed.values.config, "--config");

    const dbManager = new DatabaseManager();
    try {
      const repo = new TaskRepository(dbManager);
      const scheduler = new TaskScheduler(repo);
      const res = scheduler.getProjectLogs(targetDir, {
        taskId,
        limit,
        configFileName,
      });

      if (parsed.values.json) {
        console.log(JSON.stringify(res, null, 2));
        return { mode: "cli", exitCode: 0 };
      }

      console.log(
        `Audit logs for ${res.project.project_name} (${res.project.project_id}) [showing ${res.events.length}]:`
      );
      for (const ev of res.events) {
        console.log(
          `  ${ev.created_at} [${ev.event_type}] task=${ev.task_id ?? "(project)"} actor=${ev.actor} details=${JSON.stringify(ev.details)}`
        );
      }
    } finally {
      dbManager.close();
    }

    return { mode: "cli", exitCode: 0 };
  }

  if (subcommand === "projects") {
    const parsed = parseArgs({
      args: subArgs,
      options: {
        prune: { type: "boolean" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    });

    if (parsed.values.help) {
      printHelp();
      return { mode: "cli", exitCode: 0 };
    }

    const dbManager = new DatabaseManager();
    try {
      const repo = new TaskRepository(dbManager);
      const scheduler = new TaskScheduler(repo);

      if (parsed.values.prune) {
        const pruneRes = scheduler.pruneOrphanedProjects();
        if (parsed.values.json) {
          console.log(JSON.stringify(pruneRes, null, 2));
          return { mode: "cli", exitCode: 0 };
        }
        console.log(
          `Pruned ${pruneRes.removed_projects.length} orphaned project(s). Remaining: ${pruneRes.remaining_count}.`
        );
        for (const p of pruneRes.removed_projects) {
          console.log(`  - removed ${p.project_name} (${p.project_id}) at ${p.root_path}`);
        }
        return { mode: "cli", exitCode: 0 };
      }

      const projects = scheduler.listRegisteredProjects();
      if (parsed.values.json) {
        console.log(JSON.stringify({ projects }, null, 2));
        return { mode: "cli", exitCode: 0 };
      }

      if (projects.length === 0) {
        console.log("No projects registered in central SQLite DB.");
      } else {
        console.log(`Registered projects (${projects.length}):`);
        for (const p of projects) {
          console.log(
            `  - ${p.project_name} (${p.project_id}) [config_exists=${p.config_exists} config_valid=${p.config_valid}] root=${p.root_path}`
          );
        }
      }
    } finally {
      dbManager.close();
    }

    return { mode: "cli", exitCode: 0 };
  }

  console.error(`Unknown subcommand "${subcommand}". Run "moex --help" for usage.`);
  return { mode: "cli", exitCode: 1 };
}
