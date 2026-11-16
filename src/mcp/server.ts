import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { TaskScheduler } from "../domain/scheduler.ts";
import { DatabaseManager } from "../storage/database.ts";
import { TaskRepository } from "../storage/task-repository.ts";
import {
  MOEX_VERSION,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TasklistError,
} from "../types.ts";

export interface McpServerDefaults {
  projectDir?: string;
  configFileName?: string;
}

function logStderr(message: string): void {
  process.stderr.write(`[moex] ${message}\n`);
}

function jsonToolResult(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function errorToolResult(err: unknown) {
  if (err instanceof TasklistError) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              error: true,
              code: err.code,
              message: err.message,
              ...(err.details ? { details: err.details } : {}),
            },
            null,
            2
          ),
        },
      ],
    };
  }

  const msg = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            error: true,
            code: "INTERNAL_ERROR",
            message: msg,
          },
          null,
          2
        ),
      },
    ],
  };
}

async function safeToolCall(fn: () => unknown | Promise<unknown>) {
  try {
    const result = await fn();
    return jsonToolResult(result);
  } catch (err) {
    return errorToolResult(err);
  }
}

export function createTasklistMcpServer(
  scheduler: TaskScheduler,
  defaults: McpServerDefaults = {}
): McpServer {
  const server = new McpServer({
    name: "moex",
    version: MOEX_VERSION,
  });

  const resolvePath = (p?: string) => p?.trim() || defaults.projectDir;
  const resolveCfg = (c?: string) => c?.trim() || defaults.configFileName;

  // 1. set_project_context
  server.registerTool(
    "set_project_context",
    {
      title: "Set Project Shared Context",
      description:
        "Store or update global project architecture decisions, tech stack, conventions, and shared contracts. Automatically hydrated on every claim_next_task call to prevent context amnesia across tasks and sessions.",
      inputSchema: {
        project_path: z
          .string()
          .optional()
          .describe("Absolute path to the project directory (defaults to server project dir/cwd)."),
        config_file: z
          .string()
          .optional()
          .describe("Optional custom config filename (defaults to .moex.json)."),
        architecture_summary: z.string().optional(),
        tech_stack: z
          .union([z.array(z.string()), z.record(z.string(), z.string())])
          .optional(),
        conventions: z
          .union([z.array(z.string()), z.record(z.string(), z.string())])
          .optional(),
        shared_contracts: z.record(z.string(), z.unknown()).optional(),
        notes: z.array(z.string()).optional(),
        replace: z
          .boolean()
          .optional()
          .describe("If true, replaces shared_context completely instead of merging top-level keys."),
        actor: z.string().optional(),
      },
    },
    async (args) =>
      safeToolCall(() =>
        scheduler.setProjectContext(
          resolvePath(args.project_path),
          {
            ...(args.architecture_summary !== undefined
              ? { architecture_summary: args.architecture_summary }
              : {}),
            ...(args.tech_stack !== undefined ? { tech_stack: args.tech_stack } : {}),
            ...(args.conventions !== undefined ? { conventions: args.conventions } : {}),
            ...(args.shared_contracts !== undefined
              ? { shared_contracts: args.shared_contracts }
              : {}),
            ...(args.notes !== undefined ? { notes: args.notes } : {}),
          },
          {
            replace: args.replace,
            actor: args.actor,
            configFileName: resolveCfg(args.config_file),
          }
        )
      )
  );

  // 2. create_tasks
  server.registerTool(
    "create_tasks",
    {
      title: "Create Tasks (Batch DAG & Dynamic Injection)",
      description:
        "Create one or more tasks in an atomic transaction. Supports local batch 'key' references for depends_on, cycle detection, affected_files conflict metadata, and dynamic prerequisite injection via blocks_task_ids (automatically suspending in_progress targets back to pending).",
      inputSchema: {
        project_path: z.string().optional(),
        config_file: z.string().optional(),
        actor: z.string().optional(),
        tasks: z
          .array(
            z.object({
              key: z
                .string()
                .optional()
                .describe("Temporary local key to reference this task inside depends_on within the same batch."),
              title: z.string().min(1),
              description: z.string().optional(),
              category: z.string().optional(),
              priority: z.enum(TASK_PRIORITIES).optional(),
              acceptance_criteria: z.array(z.string()).optional(),
              verification_command: z
                .string()
                .nullable()
                .optional()
                .describe("Shell command run by Active Verification Gate when completing this task."),
              affected_files: z
                .array(z.string())
                .optional()
                .describe("Relative file paths expected to be edited by this task (used to avoid parallel agent conflicts)."),
              depends_on: z
                .array(z.string())
                .optional()
                .describe("Existing task IDs (e.g. TASK-1) or local batch keys that must finish before this task."),
              blocks_task_ids: z
                .array(z.string())
                .optional()
                .describe("Inject this new task as a prerequisite before existing task IDs (suspends in_progress targets)."),
            })
          )
          .min(1),
      },
    },
    async (args) =>
      safeToolCall(() =>
        scheduler.createTasksBatch(resolvePath(args.project_path), args.tasks, {
          actor: args.actor,
          configFileName: resolveCfg(args.config_file),
        })
      )
  );

  // 3. list_tasks
  server.registerTool(
    "list_tasks",
    {
      title: "List Project Tasks",
      description:
        "List tasks for the initialized project with optional filters for status, priority, category, claimed_by, or only_actionable.",
      inputSchema: {
        project_path: z.string().optional(),
        config_file: z.string().optional(),
        status: z.enum(TASK_STATUSES).optional(),
        priority: z.enum(TASK_PRIORITIES).optional(),
        category: z.string().optional(),
        claimed_by: z.string().optional(),
        only_actionable: z
          .boolean()
          .optional()
          .describe("When true, returns only pending tasks whose dependencies are all done."),
      },
    },
    async (args) =>
      safeToolCall(() => ({
        tasks: scheduler.listTasks(
          resolvePath(args.project_path),
          {
            status: args.status,
            priority: args.priority,
            category: args.category,
            claimed_by: args.claimed_by,
            only_actionable: args.only_actionable,
          },
          resolveCfg(args.config_file)
        ),
      }))
  );

  // 4. get_task_detail
  server.registerTool(
    "get_task_detail",
    {
      title: "Get Task Detail",
      description:
        "Retrieve full details of a single task including prerequisite handoffs, dependent tasks, last verification output, and event history.",
      inputSchema: {
        project_path: z.string().optional(),
        config_file: z.string().optional(),
        task_id: z.string().min(1),
      },
    },
    async (args) =>
      safeToolCall(() =>
        scheduler.getTaskDetail(
          resolvePath(args.project_path),
          args.task_id,
          resolveCfg(args.config_file)
        )
      )
  );

  // 5. claim_next_task
  server.registerTool(
    "claim_next_task",
    {
      title: "Claim Next Actionable Task",
      description:
        "Atomically claim the highest-priority unblocked pending task. Performs stale lease recovery, skips tasks with affected_files overlapping active in_progress tasks, hydrates project_shared_context + prerequisite_handoffs, and returns a strict queue outcome (TASK_CLAIMED, WAITING_ON_ACTIVE_TASKS, BLOCKED_BY_FAILURES, PROJECT_COMPLETED, or NO_TASKS_PLANNED).",
      inputSchema: {
        project_path: z.string().optional(),
        config_file: z.string().optional(),
        agent_id: z
          .string()
          .min(1)
          .describe("Unique identifier of the claiming agent or subagent (e.g. 'claude-main', 'worker-api')."),
        category: z.string().optional(),
        ignore_file_locks: z
          .boolean()
          .optional()
          .describe("Set true to claim a task even if affected_files overlap an active in_progress task."),
        prefer_task_id: z.string().optional(),
      },
    },
    async (args) =>
      safeToolCall(() =>
        scheduler.claimNextTask(
          resolvePath(args.project_path),
          args.agent_id,
          {
            category: args.category,
            ignore_file_locks: args.ignore_file_locks,
            prefer_task_id: args.prefer_task_id,
          },
          resolveCfg(args.config_file)
        )
      )
  );

  // 6. update_task
  server.registerTool(
    "update_task",
    {
      title: "Update Task / Heartbeat / Unblock",
      description:
        "Update task metadata, log incremental handoff_notes or modified_files, refresh lease heartbeat, mutate dependencies (with cycle validation), or reset a blocked/failed task back to pending.",
      inputSchema: {
        project_path: z.string().optional(),
        config_file: z.string().optional(),
        task_id: z.string().min(1),
        actor: z.string().optional(),
        title: z.string().optional(),
        description: z.string().optional(),
        category: z.string().optional(),
        priority: z.enum(TASK_PRIORITIES).optional(),
        acceptance_criteria: z.array(z.string()).optional(),
        verification_command: z.string().nullable().optional(),
        affected_files: z.array(z.string()).optional(),
        modified_files: z.array(z.string()).optional(),
        append_modified_files: z.boolean().optional(),
        handoff_notes: z.string().optional(),
        heartbeat: z
          .boolean()
          .optional()
          .describe("Refresh heartbeat_at for an active in_progress task to prevent lease expiration."),
        reset_to_pending: z
          .boolean()
          .optional()
          .describe("Reset blocked/failed/in_progress task back to pending and release claim."),
        reset_attempts: z.boolean().optional(),
        add_depends_on: z.array(z.string()).optional(),
        remove_depends_on: z.array(z.string()).optional(),
      },
    },
    async (args) =>
      safeToolCall(() =>
        scheduler.updateTask(
          resolvePath(args.project_path),
          args.task_id,
          {
            title: args.title,
            description: args.description,
            category: args.category,
            priority: args.priority,
            acceptance_criteria: args.acceptance_criteria,
            verification_command: args.verification_command,
            affected_files: args.affected_files,
            modified_files: args.modified_files,
            append_modified_files: args.append_modified_files,
            handoff_notes: args.handoff_notes,
            heartbeat: args.heartbeat,
            reset_to_pending: args.reset_to_pending,
            reset_attempts: args.reset_attempts,
            add_depends_on: args.add_depends_on,
            remove_depends_on: args.remove_depends_on,
          },
          args.actor,
          resolveCfg(args.config_file)
        )
      )
  );

  // 7. complete_task
  server.registerTool(
    "complete_task",
    {
      title: "Complete Task (Active Verification Gate)",
      description:
        "Mark a task as done after enforcing verification_note and executing any configured verification_command and/or project default_verification_command. If verification fails, rejects completion, increments attempt_count, and returns command output for remediation.",
      inputSchema: {
        project_path: z.string().optional(),
        config_file: z.string().optional(),
        task_id: z.string().min(1),
        agent_id: z.string().optional(),
        verification_note: z
          .string()
          .optional()
          .describe("Summary of checks/evidence proving acceptance criteria are met."),
        handoff_notes: z
          .string()
          .optional()
          .describe("Context, exported APIs, paths, or decisions passed to downstream tasks."),
        modified_files: z.array(z.string()).optional(),
      },
    },
    async (args) =>
      safeToolCall(() =>
        scheduler.completeTask(
          resolvePath(args.project_path),
          args.task_id,
          {
            agent_id: args.agent_id,
            verification_note: args.verification_note,
            handoff_notes: args.handoff_notes,
            modified_files: args.modified_files,
          },
          resolveCfg(args.config_file)
        )
      )
  );

  // 8. block_or_fail_task
  server.registerTool(
    "block_or_fail_task",
    {
      title: "Block, Fail, or Requeue Task",
      description:
        "Transition an active/pending task to blocked, failed, or retry_later (requeues to pending unless max_attempts is reached), recording blocker_reason and releasing the claim.",
      inputSchema: {
        project_path: z.string().optional(),
        config_file: z.string().optional(),
        task_id: z.string().min(1),
        agent_id: z.string().optional(),
        outcome: z.enum(["blocked", "failed", "retry_later"]),
        reason: z.string().min(1),
        handoff_notes: z.string().optional(),
        modified_files: z.array(z.string()).optional(),
      },
    },
    async (args) =>
      safeToolCall(() =>
        scheduler.blockOrFailTask(
          resolvePath(args.project_path),
          args.task_id,
          {
            agent_id: args.agent_id,
            outcome: args.outcome,
            reason: args.reason,
            handoff_notes: args.handoff_notes,
            modified_files: args.modified_files,
          },
          resolveCfg(args.config_file)
        )
      )
  );

  // 9. delete_task
  server.registerTool(
    "delete_task",
    {
      title: "Delete Task",
      description:
        "Delete a task from the project. Refuses deletion if downstream tasks depend on it unless force=true.",
      inputSchema: {
        project_path: z.string().optional(),
        config_file: z.string().optional(),
        task_id: z.string().min(1),
        force: z.boolean().optional(),
        actor: z.string().optional(),
      },
    },
    async (args) =>
      safeToolCall(() =>
        scheduler.deleteTask(
          resolvePath(args.project_path),
          args.task_id,
          args.force ?? false,
          args.actor,
          resolveCfg(args.config_file)
        )
      )
  );

  // 10. get_project_summary
  server.registerTool(
    "get_project_summary",
    {
      title: "Get Project Summary & Waves",
      description:
        "Get overall project progress, status counts, actionable task IDs, active in_progress locks, blockers, topological execution waves, and shared context.",
      inputSchema: {
        project_path: z.string().optional(),
        config_file: z.string().optional(),
      },
    },
    async (args) =>
      safeToolCall(() =>
        scheduler.getProjectSummary(
          resolvePath(args.project_path),
          resolveCfg(args.config_file)
        )
      )
  );

  // Resource 1: Project Summary
  server.registerResource(
    "project-summary",
    "moex://project/summary",
    {
      title: "Active Project Tasklist Summary",
      description:
        "Live task counts, execution waves, active locks, and blockers for the configured project directory.",
      mimeType: "application/json",
    },
    async (uri) => {
      try {
        const summary = scheduler.getProjectSummary(
          defaults.projectDir,
          defaults.configFileName
        );
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(summary, null, 2),
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(
                {
                  initialized: false,
                  message: msg,
                },
                null,
                2
              ),
            },
          ],
        };
      }
    }
  );

  // Resource 2: Project Shared Context
  server.registerResource(
    "project-context",
    "moex://project/context",
    {
      title: "Project Shared Architecture Context",
      description:
        "Shared architecture summary, conventions, tech stack, and global contracts stored for the configured project.",
      mimeType: "application/json",
    },
    async (uri) => {
      try {
        const ctx = scheduler.getProjectContext(
          defaults.projectDir,
          defaults.configFileName
        );
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(ctx, null, 2),
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(
                {
                  initialized: false,
                  message: msg,
                },
                null,
                2
              ),
            },
          ],
        };
      }
    }
  );

  // Prompt 1: Autonomous Workflow SOP
  server.registerPrompt(
    "autonomous-workflow",
    {
      title: "Autonomous Whole-Project Execution Workflow",
      description:
        "Standard operating procedure for an AI coding agent to plan, claim, verify, and complete an entire project autonomously using moex.",
      argsSchema: {
        project_path: z
          .string()
          .optional()
          .describe("Absolute path to the initialized target project directory."),
        goal: z
          .string()
          .optional()
          .describe("High-level user goal or feature specification to execute."),
      },
    },
    (args) => {
      const targetPathNote = args.project_path
        ? `Target project_path: "${args.project_path}". Always pass this project_path on every tool call.`
        : "Always pass the absolute `project_path` of the active workspace on every tool call.";
      const goalNote = args.goal ? `\nUser Goal:\n${args.goal}\n` : "";

      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `You are executing a whole-project autonomous workflow backed by the \`moex\` MCP server.
${targetPathNote}${goalNote}
Follow this strict execution protocol:

1. **Verify Initialization:**
   - Call \`get_project_summary\`.
   - If you receive \`PROJECT_NOT_INITIALIZED\`, run \`moex init --dir "<project_path>"\` in the terminal (or ask the user if shell execution is unavailable) before proceeding.

2. **Lock Architecture & Shared Memory:**
   - Before writing code, call \`set_project_context\` with \`architecture_summary\`, \`tech_stack\`, \`conventions\`, and \`shared_contracts\` so all tasks and future sessions share identical global rules.

3. **Plan the Task DAG:**
   - If no tasks exist yet, call \`create_tasks\` once with the full ordered DAG:
     - Use local \`key\` + \`depends_on\` to enforce proper build order (schema/config -> core logic -> API/UI -> integration tests).
     - Populate \`affected_files\` so parallel subagents do not overwrite each other's files.
     - Populate concrete \`acceptance_criteria\` and \`verification_command\` (e.g. targeted test/typecheck command).

4. **Autonomous Execution Loop:**
   - Call \`claim_next_task\` with a descriptive \`agent_id\`.
   - Inspect \`outcome\`:
     - \`TASK_CLAIMED\`: Review \`project_shared_context\`, \`prerequisite_handoffs\`, and \`acceptance_criteria\`. Implement the task cleanly.
       - For long tasks, call \`update_task(heartbeat=true, modified_files=[...], handoff_notes=...)\` periodically.
       - If you discover a missing prerequisite mid-task, call \`create_tasks\` with \`blocks_task_ids: [current_task_id]\` — this automatically suspends the current task until the prerequisite finishes.
       - When ready, call \`complete_task\` with concrete \`verification_note\`, \`handoff_notes\`, and \`modified_files\`. If the Active Verification Gate fails, inspect the returned command output, fix the code, and retry \`complete_task\`.
       - If blocked by an unresolvable external issue, call \`block_or_fail_task\`.
     - \`NO_TASKS_PLANNED\`: Call \`create_tasks\` first to build the project DAG.
     - \`WAITING_ON_ACTIVE_TASKS\`: Wait for active subagents/file locks to finish, then call \`claim_next_task\` again.
     - \`BLOCKED_BY_FAILURES\`: Inspect \`blocked_or_failed_tasks\`, resolve root causes, reset via \`update_task(reset_to_pending=true)\`, and continue.
     - \`PROJECT_COMPLETED\`: Run one final end-to-end project verification and report the completed summary to the user.`,
            },
          },
        ],
      };
    }
  );

  return server;
}

export async function startMcpStdioServer(
  defaults: McpServerDefaults = {}
): Promise<void> {
  const dbManager = new DatabaseManager();
  const repo = new TaskRepository(dbManager);
  const scheduler = new TaskScheduler(repo);
  const server = createTasklistMcpServer(scheduler, defaults);
  const transport = new StdioServerTransport();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logStderr(`Received ${signal}; closing MCP server and SQLite connection.`);
    try {
      await server.close();
    } catch (err) {
      logStderr(`Error closing MCP server: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      dbManager.close();
    } catch (err) {
      logStderr(`Error closing database: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  logStderr(`Starting stdio MCP server (db=${dbManager.dbPath})`);
  await server.connect(transport);
}
