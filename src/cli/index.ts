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
  moex unlock [--dir <path>] [--config <file>] [--task <id> | --all-stale]

Subcommands:
  init      Initialize ${DEFAULT_CONFIG_FILENAME} in a target project root and register it in the central DB.
            Automatically appends the config filename to .gitignore ONLY if .gitignore exists.
  status    Print a human-readable summary of project tasks, active locks, and blockers.
  unlock    Release stuck in_progress locks or reset a blocked/failed task back to pending.
  serve     Start the MCP stdio server (default when no subcommand is given).

Init options:
  --dir <path>              Target project directory (default: current working directory)
  --name <name>             Project display name (default: directory basename)
  --config <file>           Custom config filename (default: ${DEFAULT_CONFIG_FILENAME})
  --verify-cmd <command>    Default verification command run by Active Verification Gate
  --no-auto-verify          Disable automatic verification command execution on complete_task
  --verify-timeout <ms>     Verification command timeout in ms (default: 60000)
  --max-attempts <n>        Max failed/stale attempts before task turns failed (default: 3)
  --lease-minutes <n>       Lease timeout in minutes for stale recovery (default: 30)
  --no-require-note         Do not require verification_note on complete_task
  --new                     Generate a fresh project_id UUID even if config already exists
  --force                   Overwrite/update config settings while preserving existing project_id
  -v, --version             Show version
  -h, --help                Show help
`);
}

function parsePositiveInt(raw: string | undefined, flagName: string): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new TasklistError(
      "VALIDATION_ERROR",
      `Flag ${flagName} must be a positive integer, received "${raw}".`
    );
  }
  return parsed;
}

export function runCliCommand(argv: readonly string[]): CliResult {
  const args = [...argv];
  const first = args[0];

  if (first === "-v" || first === "--version" || first === "version") {
    console.log(`moex v${MOEX_VERSION}`);
    return { mode: "cli", exitCode: 0 };
  }

  if (first === "-h" || first === "--help" || first === "help") {
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
        projectDir: parsed.values["project-dir"],
        configFileName: parsed.values.config,
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

    const targetDir = parsed.values.dir ? path.resolve(parsed.values.dir) : process.cwd();
    const result = initProjectConfig({
      dir: targetDir,
      projectName: parsed.values.name,
      configFileName: parsed.values.config,
      defaultVerificationCommand: parsed.values["verify-cmd"],
      autoRunVerification: parsed.values["no-auto-verify"] ? false : undefined,
      verificationTimeoutMs: parsePositiveInt(
        parsed.values["verify-timeout"],
        "--verify-timeout"
      ),
      maxAttempts: parsePositiveInt(parsed.values["max-attempts"], "--max-attempts"),
      leaseTimeoutMinutes: parsePositiveInt(
        parsed.values["lease-minutes"],
        "--lease-minutes"
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
      const summary = scheduler.getProjectSummary(
        parsed.values.dir ?? process.cwd(),
        parsed.values.config
      );

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
      const res = scheduler.unlockTasks(
        parsed.values.dir ?? process.cwd(),
        {
          taskId: parsed.values.task,
          allStale: parsed.values["all-stale"] ?? false,
          configFileName: parsed.values.config,
        }
      );

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

  console.error(`Unknown subcommand "${subcommand}". Run "moex --help" for usage.`);
  return { mode: "cli", exitCode: 1 };
}
