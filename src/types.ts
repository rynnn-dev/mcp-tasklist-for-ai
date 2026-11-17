import { z } from "zod";

export const MOEX_VERSION = "1.0.0";

export const TASK_STATUSES = [
  "pending",
  "in_progress",
  "done",
  "blocked",
  "failed",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ["critical", "high", "medium", "low"] as const;

export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const PRIORITY_WEIGHT: Record<TaskPriority, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

export const ProjectConfigSchema = z.object({
  version: z.literal(1),
  project_id: z.string().uuid(),
  project_name: z.string().min(1),
  created_at: z.string().min(1),
  default_verification_command: z.string().nullable().default(null),
  auto_run_verification: z.boolean().default(true),
  verification_timeout_ms: z.number().int().min(1000).max(600000).default(60000),
  max_attempts: z.number().int().min(1).max(20).default(3),
  lease_timeout_minutes: z.number().int().min(1).max(1440).default(30),
  require_verification_note: z.boolean().default(true),
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export const ProjectSharedContextSchema = z
  .object({
    architecture_summary: z.string().optional(),
    tech_stack: z.union([z.array(z.string()), z.record(z.string(), z.string())]).optional(),
    conventions: z.union([z.array(z.string()), z.record(z.string(), z.string())]).optional(),
    shared_contracts: z.record(z.string(), z.unknown()).optional(),
    notes: z.array(z.string()).optional(),
  })
  .passthrough();

export type ProjectSharedContext = z.infer<typeof ProjectSharedContextSchema>;

export interface ResolvedProject {
  config: ProjectConfig;
  project_root: string;
  config_path: string;
  config_file_name: string;
}

export interface ProjectRecord {
  project_id: string;
  project_name: string;
  root_path: string;
  config_path: string;
  shared_context: ProjectSharedContext;
  created_at: string;
  updated_at: string;
}

export interface TaskRecord {
  project_id: string;
  id: string;
  seq_num: number;
  title: string;
  description: string;
  category: string;
  status: TaskStatus;
  priority: TaskPriority;
  acceptance_criteria: string[];
  verification_command: string | null;
  affected_files: string[];
  modified_files: string[];
  handoff_notes: string;
  verification_note: string;
  last_verification_output: string;
  claimed_by: string | null;
  claimed_at: string | null;
  heartbeat_at: string | null;
  attempt_count: number;
  blocker_reason: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  depends_on: string[];
}

export interface TaskEventRecord {
  id: number;
  project_id: string;
  task_id: string | null;
  event_type: string;
  actor: string;
  details: Record<string, unknown>;
  created_at: string;
}

export interface PrerequisiteHandoff {
  task_id: string;
  title: string;
  status: TaskStatus;
  handoff_notes: string;
  modified_files: string[];
  verification_note: string;
}

export type ClaimOutcome =
  | "TASK_CLAIMED"
  | "WAITING_ON_ACTIVE_TASKS"
  | "BLOCKED_BY_FAILURES"
  | "PROJECT_COMPLETED"
  | "NO_TASKS_PLANNED";

export interface ClaimNextResult {
  outcome: ClaimOutcome;
  task: TaskRecord | null;
  project_shared_context: ProjectSharedContext;
  prerequisite_handoffs: PrerequisiteHandoff[];
  stale_reclaimed_task_ids: string[];
  stale_failed_task_ids: string[];
  skipped_due_to_file_locks: Array<{
    task_id: string;
    title: string;
    conflicting_files: string[];
    locked_by_task_ids: string[];
  }>;
  active_tasks: Array<{
    id: string;
    title: string;
    claimed_by: string | null;
    affected_files: string[];
    modified_files: string[];
  }>;
  blocked_or_failed_tasks: Array<{
    id: string;
    title: string;
    status: TaskStatus;
    blocker_reason: string;
    attempt_count: number;
  }>;
  message: string;
}

export interface VerificationStepResult {
  tier: "task" | "project_default";
  command: string;
  exit_code: number | null;
  timed_out: boolean;
  passed: boolean;
  duration_ms: number;
  output_snippet: string;
}

export interface VerificationResult {
  passed: boolean;
  steps: VerificationStepResult[];
  combined_output: string;
}

export interface VerificationProgressUpdate {
  tier: "task" | "project_default";
  command: string;
  step_index: number;
  total_steps: number;
  elapsed_ms: number;
  phase: "start" | "tick" | "done";
}

export type TasklistErrorCode =
  | "PROJECT_NOT_INITIALIZED"
  | "PROJECT_ALREADY_INITIALIZED"
  | "INVALID_PROJECT_CONFIG"
  | "INVALID_PATH"
  | "TASK_NOT_FOUND"
  | "CYCLE_DETECTED"
  | "INVALID_DEPENDENCY"
  | "INVALID_STATE_TRANSITION"
  | "TASK_LOCKED"
  | "VERIFICATION_FAILED"
  | "VALIDATION_ERROR";

export class TasklistError extends Error {
  public readonly code: TasklistErrorCode;
  public readonly details?: Record<string, unknown>;

  constructor(
    code: TasklistErrorCode,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "TasklistError";
    this.code = code;
    this.details = details;
  }
}
