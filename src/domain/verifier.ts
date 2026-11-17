import { spawn } from "node:child_process";
import type {
  VerificationProgressUpdate,
  VerificationResult,
  VerificationStepResult,
} from "../types.ts";

export const MAX_VERIFICATION_OUTPUT_CHARS = 8192;
const MAX_STREAM_BUFFER_CHARS = 65536;
const DEFAULT_PROGRESS_INTERVAL_MS = 1000;

export function truncateOutputTail(
  text: string,
  maxChars = MAX_VERIFICATION_OUTPUT_CHARS
): string {
  if (text.length <= maxChars) {
    return text;
  }
  const omitted = text.length - maxChars;
  return `...[truncated ${omitted} leading chars]...\n${text.slice(-maxChars)}`;
}

function appendBounded(current: string, chunk: string): string {
  const combined = current + chunk;
  if (combined.length <= MAX_STREAM_BUFFER_CHARS) {
    return combined;
  }
  return combined.slice(-MAX_STREAM_BUFFER_CHARS);
}

async function runSingleCommand(
  tier: "task" | "project_default",
  command: string,
  cwd: string,
  timeoutMs: number,
  stepIndex: number,
  totalSteps: number,
  onProgress?: (update: VerificationProgressUpdate) => void | Promise<void>,
  progressIntervalMs = DEFAULT_PROGRESS_INTERVAL_MS
): Promise<VerificationStepResult> {
  const startedAt = Date.now();
  let timedOut = false;
  let stdoutBuf = "";
  let stderrBuf = "";

  const emitProgress = (phase: "start" | "tick" | "done") => {
    if (!onProgress) return;
    try {
      void Promise.resolve(
        onProgress({
          tier,
          command,
          step_index: stepIndex,
          total_steps: totalSteps,
          elapsed_ms: Date.now() - startedAt,
          phase,
        })
      ).catch(() => {
        // Ignore progress callback failures so verification never aborts
      });
    } catch {
      // Ignore synchronous progress callback failures
    }
  };

  emitProgress("start");

  return await new Promise<VerificationStepResult>((resolve) => {
    const useProcessGroup = process.platform !== "win32";
    const child = spawn("sh", ["-c", command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      detached: useProcessGroup,
    });

    const killTree = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      if (useProcessGroup) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // fall back to direct child kill
        }
      }
      try {
        child.kill(signal);
      } catch {
        // ignore if already exited
      }
    };

    let settled = false;
    let killGraceTimer: ReturnType<typeof setTimeout> | undefined;
    let hardCloseTimer: ReturnType<typeof setTimeout> | undefined;
    const progressTimer =
      onProgress && progressIntervalMs > 0
        ? setInterval(() => emitProgress("tick"), progressIntervalMs)
        : undefined;

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (progressTimer !== undefined) clearInterval(progressTimer);
      if (killGraceTimer !== undefined) clearTimeout(killGraceTimer);
      if (hardCloseTimer !== undefined) clearTimeout(hardCloseTimer);

      const durationMs = Date.now() - startedAt;
      const segments: string[] = [];
      if (stdoutBuf.trim()) {
        segments.push(`[stdout]\n${stdoutBuf.trimEnd()}`);
      }
      if (stderrBuf.trim()) {
        segments.push(`[stderr]\n${stderrBuf.trimEnd()}`);
      }
      if (timedOut) {
        segments.push(
          `[timeout] Verification command exceeded ${timeoutMs}ms and was terminated.`
        );
      }

      const combined = segments.join("\n\n");
      const passed = !timedOut && exitCode === 0;

      emitProgress("done");

      resolve({
        tier,
        command,
        exit_code: timedOut ? null : exitCode,
        timed_out: timedOut,
        passed,
        duration_ms: durationMs,
        output_snippet: truncateOutputTail(combined),
      });
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killTree("SIGTERM");
      killGraceTimer = setTimeout(() => {
        killTree("SIGKILL");
      }, 200);
      // Failsafe in case an unkillable fd keeps stdio streams open
      hardCloseTimer = setTimeout(() => {
        finish(null);
      }, 1000);
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdoutBuf = appendBounded(stdoutBuf, chunk);
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderrBuf = appendBounded(stderrBuf, chunk);
    });

    child.on("error", (err) => {
      stderrBuf = appendBounded(stderrBuf, `\nSpawn error: ${err.message}`);
      finish(1);
    });

    child.on("close", (code) => {
      finish(code);
    });
  });
}

/**
 * Executes active verification commands in two tiers:
 * 1) Task-specific verification_command (if provided)
 * 2) Project default_verification_command (mandatory baseline if configured)
 * Stops on first failure (fail-fast).
 */
export async function runVerificationGate(params: {
  projectRoot: string;
  taskCommand: string | null;
  defaultCommand: string | null;
  timeoutMs: number;
  onProgress?: (update: VerificationProgressUpdate) => void | Promise<void>;
  progressIntervalMs?: number;
}): Promise<VerificationResult> {
  const queue: Array<{ tier: "task" | "project_default"; command: string }> = [];

  const taskCmd = params.taskCommand?.trim() || "";
  const defaultCmd = params.defaultCommand?.trim() || "";

  if (taskCmd) {
    queue.push({ tier: "task", command: taskCmd });
  }
  if (defaultCmd && defaultCmd !== taskCmd) {
    queue.push({ tier: "project_default", command: defaultCmd });
  }

  if (queue.length === 0) {
    return {
      passed: true,
      steps: [],
      combined_output: "",
    };
  }

  const steps: VerificationStepResult[] = [];
  let allPassed = true;

  for (let i = 0; i < queue.length; i++) {
    const item = queue[i]!;
    const step = await runSingleCommand(
      item.tier,
      item.command,
      params.projectRoot,
      params.timeoutMs,
      i + 1,
      queue.length,
      params.onProgress,
      params.progressIntervalMs
    );
    steps.push(step);
    if (!step.passed) {
      allPassed = false;
      break;
    }
  }

  const formattedOutput = steps
    .map(
      (s) =>
        `=== [${s.tier}] ${s.command} (${s.passed ? "PASS" : "FAIL"}, exit=${
          s.exit_code ?? "timeout"
        }, ${s.duration_ms}ms) ===\n${s.output_snippet || "(no output)"}`
    )
    .join("\n\n");

  return {
    passed: allPassed,
    steps,
    combined_output: truncateOutputTail(formattedOutput),
  };
}
