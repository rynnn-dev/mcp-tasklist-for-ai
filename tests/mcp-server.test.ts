import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
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
});
