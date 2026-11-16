#!/usr/bin/env bun
import { runCliCommand } from "./cli/index.ts";
import { startMcpStdioServer } from "./mcp/server.ts";
import { TasklistError } from "./types.ts";

async function main(): Promise<void> {
  try {
    const cliResult = runCliCommand(process.argv.slice(2));
    if (cliResult.mode === "serve") {
      await startMcpStdioServer(cliResult.serveOptions);
      return;
    }
    process.exit(cliResult.exitCode);
  } catch (err) {
    if (err instanceof TasklistError) {
      process.stderr.write(`[moex] [${err.code}] ${err.message}\n`);
    } else {
      process.stderr.write(
        `[moex] Error: ${err instanceof Error ? err.message : String(err)}\n`
      );
    }
    process.exit(1);
  }
}

void main();
