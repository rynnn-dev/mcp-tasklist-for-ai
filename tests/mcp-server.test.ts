import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { initProjectConfig } from "../src/config/project-config.ts";
import { TaskScheduler } from "../src/domain/scheduler.ts";
import { createTasklistMcpServer } from "../src/mcp/server.ts";
import { DatabaseManager } from "../src/storage/database.ts";
import { TaskRepository } from "../src/storage/task-repository.ts";
import { TasklistError } from "../src/types.ts";

let tempRoot = "";
let prevDbEnv: string | undefined;

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), "moex-e2e-test-"));
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

function parseToolText(result: { content: Array<{ type: string; text?: string }> }): any {
  const first = result.content[0];
  expect(first?.type).toBe("text");
  return JSON.parse(first?.text ?? "{}");
}

describe("MCP Server Protocol E2E", () => {
  test("exposes 10 tools, 2 resources, 1 prompt and executes full autonomous loop over InMemoryTransport", async () => {
    const projDir = path.join(tempRoot, "app-repo");
    const uninitDir = path.join(tempRoot, "uninit-repo");
    mkdirSync(projDir, { recursive: true });
    mkdirSync(uninitDir, { recursive: true });

    initProjectConfig({
      dir: projDir,
      projectName: "app-repo",
      defaultVerificationCommand: "echo 'all green'",
    });

    const dbManager = new DatabaseManager(path.join(tempRoot, "central.db"));
    const scheduler = new TaskScheduler(new TaskRepository(dbManager));
    const server = createTasklistMcpServer(scheduler, { projectDir: projDir });
    const client = new Client({ name: "test-client", version: "1.0.0" });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name).sort()).toEqual([
        "block_or_fail_task",
        "claim_next_task",
        "complete_task",
        "create_tasks",
        "delete_task",
        "get_project_summary",
        "get_task_detail",
        "list_tasks",
        "set_project_context",
        "update_task",
      ]);

      const resources = await client.listResources();
      expect(resources.resources.map((r) => r.uri).sort()).toEqual([
        "moex://project/context",
        "moex://project/summary",
      ]);

      const prompts = await client.listPrompts();
      expect(prompts.prompts.map((p) => p.name)).toEqual(["autonomous-workflow"]);

      const promptRes = await client.getPrompt({
        name: "autonomous-workflow",
        arguments: { project_path: projDir, goal: "Build todo API" },
      });
      expect(promptRes.messages[0]?.content.type).toBe("text");

      // Uninitialized project returns structured isError: true
      const uninitCall = await client.callTool({
        name: "get_project_summary",
        arguments: { project_path: uninitDir },
      });
      expect(uninitCall.isError).toBe(true);
      const uninitPayload = parseToolText(uninitCall as any);
      expect(uninitPayload.code).toBe("PROJECT_NOT_INITIALIZED");

      // Autonomous workflow execution on initialized project
      const emptyClaim = parseToolText(
        (await client.callTool({
          name: "claim_next_task",
          arguments: { project_path: projDir, agent_id: "claude-main" },
        })) as any
      );
      expect(emptyClaim.outcome).toBe("NO_TASKS_PLANNED");

      await client.callTool({
        name: "set_project_context",
        arguments: {
          project_path: projDir,
          architecture_summary: "REST API with Bun",
          tech_stack: ["TypeScript", "Bun"],
        },
      });

      const created = parseToolText(
        (await client.callTool({
          name: "create_tasks",
          arguments: {
            project_path: projDir,
            tasks: [
              {
                key: "setup",
                title: "Init server",
                acceptance_criteria: ["Starts cleanly"],
                affected_files: ["src/app.ts"],
              },
              {
                key: "test",
                title: "Add tests",
                depends_on: ["setup"],
                affected_files: ["tests/app.test.ts"],
              },
            ],
          },
        })) as any
      );
      expect(created.tasks.length).toBe(2);

      const c1 = parseToolText(
        (await client.callTool({
          name: "claim_next_task",
          arguments: { project_path: projDir, agent_id: "claude-main" },
        })) as any
      );
      expect(c1.outcome).toBe("TASK_CLAIMED");
      expect(c1.task.id).toBe("TASK-1");
      expect(c1.project_shared_context.architecture_summary).toBe("REST API with Bun");

      await client.callTool({
        name: "update_task",
        arguments: {
          project_path: projDir,
          task_id: "TASK-1",
          agent_id: "claude-main",
          heartbeat: true,
          handoff_notes: "Server exported on port 3000",
        },
      });

      const done1 = parseToolText(
        (await client.callTool({
          name: "complete_task",
          arguments: {
            project_path: projDir,
            task_id: "TASK-1",
            agent_id: "claude-main",
            verification_note: "Server starts and passes baseline",
            modified_files: ["src/app.ts"],
          },
        })) as any
      );
      expect(done1.task.status).toBe("done");
      expect(done1.newly_unblocked_task_ids).toEqual(["TASK-2"]);

      const c2 = parseToolText(
        (await client.callTool({
          name: "claim_next_task",
          arguments: { project_path: projDir, agent_id: "claude-main" },
        })) as any
      );
      expect(c2.task.id).toBe("TASK-2");
      expect(c2.prerequisite_handoffs[0].handoff_notes).toBe(
        "Server exported on port 3000"
      );

      await client.callTool({
        name: "complete_task",
        arguments: {
          project_path: projDir,
          task_id: "TASK-2",
          agent_id: "claude-main",
          verification_note: "All tests pass",
          modified_files: ["tests/app.test.ts"],
        },
      });

      const finished = parseToolText(
        (await client.callTool({
          name: "claim_next_task",
          arguments: { project_path: projDir, agent_id: "claude-main" },
        })) as any
      );
      expect(finished.outcome).toBe("PROJECT_COMPLETED");

      const summaryRes = await client.readResource({
        uri: "moex://project/summary",
      });
      const summaryJson = JSON.parse(
        (summaryRes.contents[0] as { text: string }).text
      );
      expect(summaryJson.completion_percentage).toBe(100);
    } finally {
      await client.close();
      await server.close();
      dbManager.close();
    }
  });

  test("communicates cleanly over real stdio child process without stdout JSON-RPC corruption", async () => {
    const projDir = path.join(tempRoot, "stdio-proj");
    mkdirSync(projDir, { recursive: true });
    initProjectConfig({ dir: projDir, projectName: "stdio-proj" });

    const entrypoint = path.resolve(import.meta.dir, "../src/index.ts");
    const transport = new StdioClientTransport({
      command: "bun",
      args: ["run", entrypoint, "serve", "--project-dir", projDir],
      env: {
        ...process.env,
        MOEX_DB_PATH: path.join(tempRoot, "central.db"),
      } as Record<string, string>,
      stderr: "pipe",
    });

    const client = new Client({ name: "stdio-test-client", version: "1.0.0" });
    await client.connect(transport);

    try {
      const summaryCall = await client.callTool({
        name: "get_project_summary",
        arguments: {},
      });
      expect(summaryCall.isError).toBeUndefined();
      const summary = parseToolText(summaryCall as any);
      expect(summary.project.project_name).toBe("stdio-proj");
      expect(summary.counts.total).toBe(0);
    } finally {
      await client.close();
    }
  });

  test("supports release_claim handoff, ResourceTemplate by project_id, static resource fallback, and notifications/progress", async () => {
    const projDir = path.join(tempRoot, "template-proj");
    mkdirSync(projDir, { recursive: true });
    const init = initProjectConfig({
      dir: projDir,
      projectName: "template-proj",
      defaultVerificationCommand: "echo 'baseline-ok'",
    });

    const dbManager = new DatabaseManager(path.join(tempRoot, "central.db"));
    const scheduler = new TaskScheduler(new TaskRepository(dbManager));
    // Intentionally omit defaults.projectDir so static resource fallback is exercised
    const server = createTasklistMcpServer(scheduler);
    const client = new Client({ name: "template-client", version: "1.0.0" });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      await client.callTool({
        name: "set_project_context",
        arguments: {
          project_path: projDir,
          architecture_summary: "Event-driven worker",
        },
      });

      await client.callTool({
        name: "create_tasks",
        arguments: {
          project_path: projDir,
          tasks: [
            {
              title: "Long verification task",
              verification_command: "sleep 1.15 && echo 'verified'",
            },
          ],
        },
      });

      const claimed = parseToolText(
        (await client.callTool({
          name: "claim_next_task",
          arguments: { project_path: projDir, agent_id: "worker-a" },
        })) as any
      );
      expect(claimed.task.id).toBe("TASK-1");

      // Release claim cleanly for handoff
      const released = parseToolText(
        (await client.callTool({
          name: "update_task",
          arguments: {
            project_path: projDir,
            task_id: "TASK-1",
            agent_id: "worker-a",
            release_claim: true,
            handoff_notes: "Handing off to worker-b",
          },
        })) as any
      );
      expect(released.status).toBe("pending");
      expect(released.claimed_by).toBeNull();

      // Re-claim as worker-b
      const reclaimed = parseToolText(
        (await client.callTool({
          name: "claim_next_task",
          arguments: { project_path: projDir, agent_id: "worker-b" },
        })) as any
      );
      expect(reclaimed.task.claimed_by).toBe("worker-b");
      expect(reclaimed.task.handoff_notes).toBe("Handing off to worker-b");

      // Complete with onprogress to capture 2-tier notifications/progress including periodic ticks
      const progressEvents: Array<{ progress: number; total?: number; message?: string }> = [];
      const done = parseToolText(
        (await client.callTool(
          {
            name: "complete_task",
            arguments: {
              project_path: projDir,
              task_id: "TASK-1",
              agent_id: "worker-b",
              verification_note: "Passed with progress stream",
            },
          },
          undefined,
          {
            onprogress: (p) => {
              progressEvents.push(p);
            },
          }
        )) as any
      );
      expect(done.task.status).toBe("done");
      expect(progressEvents.length).toBeGreaterThanOrEqual(5);
      expect(progressEvents.some((p) => p.message?.includes("[1/2 task]"))).toBe(true);
      expect(progressEvents.some((p) => p.message?.includes("[2/2 project_default]"))).toBe(true);
      expect(progressEvents.some((p) => p.message?.includes(" tick ("))).toBe(true);
      for (let i = 1; i < progressEvents.length; i++) {
        expect(progressEvents[i]!.progress).toBeGreaterThan(
          progressEvents[i - 1]!.progress
        );
      }

      // Verify static resources + ResourceTemplates list & read by project_id
      const staticResources = await client.listResources();
      expect(staticResources.resources.map((r) => r.uri).sort()).toEqual([
        "moex://project/context",
        "moex://project/summary",
        `moex://projects/${init.config.project_id}/context`,
        `moex://projects/${init.config.project_id}/summary`,
      ]);

      const templates = await client.listResourceTemplates();
      expect(templates.resourceTemplates.map((t) => t.uriTemplate).sort()).toEqual([
        "moex://projects/{project_id}/context",
        "moex://projects/{project_id}/summary",
      ]);

      const byIdSummary = await client.readResource({
        uri: `moex://projects/${init.config.project_id}/summary`,
      });
      const parsedById = JSON.parse(
        (byIdSummary.contents[0] as { text: string }).text
      );
      expect(parsedById.counts.done).toBe(1);
      expect(parsedById.recent_events.length).toBeGreaterThanOrEqual(1);

      const byIdContext = await client.readResource({
        uri: `moex://projects/${init.config.project_id}/context`,
      });
      const parsedCtx = JSON.parse(
        (byIdContext.contents[0] as { text: string }).text
      );
      expect(parsedCtx.project.shared_context.architecture_summary).toBe(
        "Event-driven worker"
      );

      // Verify static resource fallback works even without defaults.projectDir
      const fallbackSummary = await client.readResource({
        uri: "moex://project/summary",
      });
      const parsedFallback = JSON.parse(
        (fallbackSummary.contents[0] as { text: string }).text
      );
      expect(parsedFallback.project.project_id).toBe(init.config.project_id);

      // Re-init with --new supersedes old project_id; old ResourceTemplate URI must be excluded & return PROJECT_NOT_INITIALIZED
      const newInit = initProjectConfig({
        dir: projDir,
        projectName: "template-proj-v2",
        newProject: true,
      });
      expect(newInit.config.project_id).not.toBe(init.config.project_id);

      const afterRotateResources = await client.listResources();
      expect(
        afterRotateResources.resources.some((r) =>
          r.uri.includes(init.config.project_id)
        )
      ).toBe(false);

      const supersededRead = await client.readResource({
        uri: `moex://projects/${init.config.project_id}/summary`,
      });
      const supersededPayload = JSON.parse(
        (supersededRead.contents[0] as { text: string }).text
      );
      expect(supersededPayload.code).toBe("PROJECT_NOT_INITIALIZED");
    } finally {
      await client.close();
      await server.close();
      dbManager.close();
    }
  });

  test("covers list_tasks filters, get_task_detail, VERIFICATION_FAILED, block_or_fail_task, and delete_task over MCP", async () => {
    const projDir = path.join(tempRoot, "full-tools-proj");
    mkdirSync(projDir, { recursive: true });
    initProjectConfig({
      dir: projDir,
      projectName: "full-tools-proj",
      maxAttempts: 3,
    });

    const dbManager = new DatabaseManager(path.join(tempRoot, "central.db"));
    const scheduler = new TaskScheduler(new TaskRepository(dbManager));
    const server = createTasklistMcpServer(scheduler, { projectDir: projDir });
    const client = new Client({ name: "full-tools-client", version: "1.0.0" });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      await client.callTool({
        name: "create_tasks",
        arguments: {
          tasks: [
            {
              key: "base",
              title: "Failing verification check",
              category: "backend",
              verification_command: "echo 'boom' >&2 && exit 1",
            },
            {
              key: "child",
              title: "Dependent frontend task",
              category: "frontend",
              depends_on: ["base"],
            },
          ],
        },
      });

      // 1. list_tasks with filters
      const actionable = parseToolText(
        (await client.callTool({
          name: "list_tasks",
          arguments: { only_actionable: true, category: "backend" },
        })) as any
      );
      expect(actionable.tasks.map((t: any) => t.id)).toEqual(["TASK-1"]);

      // 2. get_task_detail includes dependents
      const detail2 = parseToolText(
        (await client.callTool({
          name: "get_task_detail",
          arguments: { task_id: "TASK-1" },
        })) as any
      );
      expect(detail2.dependents.map((d: any) => d.id)).toEqual(["TASK-2"]);

      // 3. Claim TASK-1 and fail Active Verification Gate over MCP
      await client.callTool({
        name: "claim_next_task",
        arguments: { agent_id: "mcp-worker" },
      });

      const failedVerify = await client.callTool({
        name: "complete_task",
        arguments: {
          task_id: "TASK-1",
          agent_id: "mcp-worker",
          verification_note: "Expecting failure",
        },
      });
      expect(failedVerify.isError).toBe(true);
      const failedPayload = parseToolText(failedVerify as any);
      expect(failedPayload.code).toBe("VERIFICATION_FAILED");
      expect(failedPayload.details.attempt_count).toBe(1);

      // 4. block_or_fail_task: retry_later -> pending, then blocked -> blocked
      const retried = parseToolText(
        (await client.callTool({
          name: "block_or_fail_task",
          arguments: {
            task_id: "TASK-1",
            agent_id: "mcp-worker",
            outcome: "retry_later",
            reason: "Needs env fix",
          },
        })) as any
      );
      expect(retried.status).toBe("pending");
      expect(retried.attempt_count).toBe(2);

      const blocked = parseToolText(
        (await client.callTool({
          name: "block_or_fail_task",
          arguments: {
            task_id: "TASK-1",
            agent_id: "mcp-worker",
            outcome: "blocked",
            reason: "Waiting for upstream key",
          },
        })) as any
      );
      expect(blocked.status).toBe("blocked");

      // 5. delete_task refuses when dependents exist (force=false), succeeds with force=true
      const delRefused = await client.callTool({
        name: "delete_task",
        arguments: { task_id: "TASK-1", force: false },
      });
      expect(delRefused.isError).toBe(true);
      expect(parseToolText(delRefused as any).code).toBe("INVALID_STATE_TRANSITION");

      const delForced = parseToolText(
        (await client.callTool({
          name: "delete_task",
          arguments: { task_id: "TASK-1", force: true },
        })) as any
      );
      expect(delForced.deleted_task_id).toBe("TASK-1");
      expect(delForced.unlinked_dependents).toEqual(["TASK-2"]);
    } finally {
      await client.close();
      await server.close();
      dbManager.close();
    }
  });

  test("rejects blank/empty Zod string arguments and handles corrupt/multi-project resource resolution cleanly", async () => {
    const projCorrupt = path.join(tempRoot, "corrupt-proj");
    const projValid = path.join(tempRoot, "valid-proj");
    const uninitDir = path.join(tempRoot, "uninitialized-dir");
    mkdirSync(projCorrupt, { recursive: true });
    mkdirSync(projValid, { recursive: true });
    mkdirSync(uninitDir, { recursive: true });

    const initA = initProjectConfig({ dir: projCorrupt, projectName: "corrupt-proj" });
    const initB = initProjectConfig({ dir: projValid, projectName: "valid-proj" });

    const dbManager = new DatabaseManager(path.join(tempRoot, "central.db"));
    const scheduler = new TaskScheduler(new TaskRepository(dbManager));
    // Register both projects in SQLite (corrupt-proj first, valid-proj second)
    scheduler.getProjectSummary(projCorrupt);
    scheduler.getProjectSummary(projValid);

    // Corrupt projA's .moex.json
    writeFileSync(initA.config_path, "{invalid-json", "utf8");

    // Direct target with corrupt config MUST throw INVALID_PROJECT_CONFIG (not silently fall back)
    expect(() => scheduler.resolveResourceTargetProject(projCorrupt)).toThrow(
      TasklistError
    );

    // Fallback with no preferredDir from an uninitialized cwd skips invalid projCorrupt and picks projValid
    const prevCwd = process.cwd();
    const prevMoexDir = process.env.MOEX_PROJECT_DIR;
    const prevLegacyDir = process.env.MCP_TASKLIST_PROJECT_DIR;
    delete process.env.MOEX_PROJECT_DIR;
    delete process.env.MCP_TASKLIST_PROJECT_DIR;
    process.chdir(uninitDir);
    try {
      const target = scheduler.resolveResourceTargetProject();
      expect(target.projectPath).toBe(initB.project_root);
    } finally {
      process.chdir(prevCwd);
      if (prevMoexDir !== undefined) process.env.MOEX_PROJECT_DIR = prevMoexDir;
      if (prevLegacyDir !== undefined) process.env.MCP_TASKLIST_PROJECT_DIR = prevLegacyDir;
    }

    // Empty-string Zod inputs rejected by MCP tools
    const server = createTasklistMcpServer(scheduler, { projectDir: projValid });
    const client = new Client({ name: "zod-validation-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      const badCalls = await Promise.all([
        client.callTool({ name: "claim_next_task", arguments: { agent_id: "   " } }),
        client.callTool({
          name: "complete_task",
          arguments: { task_id: "TASK-1", agent_id: "" },
        }),
        client.callTool({
          name: "get_task_detail",
          arguments: { task_id: "" },
        }),
        client.callTool({
          name: "list_tasks",
          arguments: { project_path: "" },
        }),
      ]);
      for (const res of badCalls) {
        expect(res.isError).toBe(true);
      }
    } finally {
      await client.close();
      await server.close();
      dbManager.close();
    }
  });
});
