import { randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ProjectConfigSchema,
  TasklistError,
  type ProjectConfig,
  type ResolvedProject,
} from "../types.ts";

export const DEFAULT_CONFIG_FILENAME = ".moex.json";

export interface InitProjectOptions {
  dir: string;
  projectName?: string;
  configFileName?: string;
  defaultVerificationCommand?: string | null;
  autoRunVerification?: boolean;
  verificationTimeoutMs?: number;
  maxAttempts?: number;
  leaseTimeoutMinutes?: number;
  requireVerificationNote?: boolean;
  newProject?: boolean;
  force?: boolean;
}

export interface InitProjectResult {
  config: ProjectConfig;
  project_root: string;
  config_path: string;
  config_file_name: string;
  gitignore_updated: boolean;
  gitignore_existed: boolean;
  previous_project_id: string | null;
}

/**
 * Validates that config file name is a safe basename inside the project root
 * (no path separators or directory traversal).
 */
export function sanitizeConfigFileName(raw?: string): string {
  const candidate = (
    raw ??
    process.env.MOEX_CONFIG ??
    process.env.MCP_TASKLIST_CONFIG ??
    DEFAULT_CONFIG_FILENAME
  ).trim();
  if (!candidate || candidate === "." || candidate === "..") {
    throw new TasklistError(
      "INVALID_PROJECT_CONFIG",
      `Invalid config filename: "${candidate}".`
    );
  }
  if (candidate.includes("/") || candidate.includes("\\") || path.basename(candidate) !== candidate) {
    throw new TasklistError(
      "INVALID_PROJECT_CONFIG",
      `Config filename must be a plain filename without path separators: "${candidate}".`
    );
  }
  return candidate;
}

/**
 * Validates that a directory is eligible as a project root (exists, is directory,
 * and is neither filesystem root nor user home directory).
 */
export function validateProjectDirectory(dirPath: string): string {
  const resolved = path.resolve(dirPath);
  if (!existsSync(resolved)) {
    throw new TasklistError(
      "INVALID_PATH",
      `Directory does not exist: "${resolved}".`
    );
  }
  const stats = statSync(resolved);
  if (!stats.isDirectory()) {
    throw new TasklistError(
      "INVALID_PATH",
      `Path is not a directory: "${resolved}".`
    );
  }
  const fsRoot = path.parse(resolved).root;
  if (resolved === fsRoot || resolved === path.resolve(os.homedir())) {
    throw new TasklistError(
      "INVALID_PATH",
      `Refusing to initialize or resolve project directly at root/home directory: "${resolved}". Run inside a specific project directory.`
    );
  }
  return resolved;
}

function writeFileAtomic(targetPath: string, content: string): void {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const tmpPath = path.join(dir, `.${base}.tmp.${process.pid}.${randomUUID()}`);
  try {
    writeFileSync(tmpPath, content, { encoding: "utf8", mode: 0o644 });
    renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      // ignore cleanup error
    }
    throw err;
  }
}

/**
 * Appends configFileName to .gitignore ONLY if .gitignore already exists.
 * Idempotent: avoids duplicate entries and preserves line endings/trailing newline.
 */
export function ensureGitignoreEntry(
  projectRoot: string,
  configFileName: string
): { gitignore_existed: boolean; gitignore_updated: boolean } {
  const gitignorePath = path.join(projectRoot, ".gitignore");
  if (!existsSync(gitignorePath)) {
    return { gitignore_existed: false, gitignore_updated: false };
  }

  const stat = statSync(gitignorePath);
  if (!stat.isFile()) {
    return { gitignore_existed: false, gitignore_updated: false };
  }

  const raw = readFileSync(gitignorePath, "utf8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(/\r?\n/);

  const normalizedTarget = configFileName.trim();
  const alreadyIgnored = lines.some((line) => {
    const trimmed = line.trim();
    return (
      trimmed === normalizedTarget ||
      trimmed === `/${normalizedTarget}` ||
      trimmed === `./${normalizedTarget}`
    );
  });

  if (alreadyIgnored) {
    return { gitignore_existed: true, gitignore_updated: false };
  }

  let nextContent = raw;
  if (nextContent.length > 0 && !nextContent.endsWith("\n")) {
    nextContent += eol;
  }
  nextContent += `${normalizedTarget}${eol}`;
  writeFileAtomic(gitignorePath, nextContent);

  return { gitignore_existed: true, gitignore_updated: true };
}

/**
 * Initializes a per-project configuration file (.moex.json by default)
 * in the target project root directory.
 */
export function initProjectConfig(options: InitProjectOptions): InitProjectResult {
  const projectRoot = validateProjectDirectory(options.dir);
  const configFileName = sanitizeConfigFileName(options.configFileName);
  const configPath = path.join(projectRoot, configFileName);

  let previousProjectId: string | null = null;
  if (existsSync(configPath)) {
    let existingConfig: ProjectConfig | null = null;
    try {
      const parsed = JSON.parse(readFileSync(configPath, "utf8"));
      const checked = ProjectConfigSchema.safeParse(parsed);
      if (checked.success) {
        existingConfig = checked.data;
        previousProjectId = checked.data.project_id;
      }
    } catch {
      existingConfig = null;
    }

    if (!options.newProject && !options.force) {
      throw new TasklistError(
        "PROJECT_ALREADY_INITIALIZED",
        `Project config "${configFileName}" already exists at "${configPath}"${
          previousProjectId ? ` (project_id: ${previousProjectId})` : ""
        }. Use --new to create a brand-new tasklist project_id, or --force to update settings.`,
        {
          config_path: configPath,
          project_id: previousProjectId,
        }
      );
    }

    // --force without --new keeps existing valid project_id so tasks remain linked
    if (options.force && !options.newProject && existingConfig) {
      const updatedConfig = ProjectConfigSchema.parse({
        version: 1,
        project_id: existingConfig.project_id,
        project_name: options.projectName?.trim() || existingConfig.project_name,
        created_at: existingConfig.created_at,
        default_verification_command:
          options.defaultVerificationCommand !== undefined
            ? options.defaultVerificationCommand
            : existingConfig.default_verification_command,
        auto_run_verification:
          options.autoRunVerification ?? existingConfig.auto_run_verification,
        verification_timeout_ms:
          options.verificationTimeoutMs ?? existingConfig.verification_timeout_ms,
        max_attempts: options.maxAttempts ?? existingConfig.max_attempts,
        lease_timeout_minutes:
          options.leaseTimeoutMinutes ?? existingConfig.lease_timeout_minutes,
        require_verification_note:
          options.requireVerificationNote ?? existingConfig.require_verification_note,
      });

      writeFileAtomic(configPath, `${JSON.stringify(updatedConfig, null, 2)}\n`);
      const gitignore = ensureGitignoreEntry(projectRoot, configFileName);
      return {
        config: updatedConfig,
        project_root: projectRoot,
        config_path: configPath,
        config_file_name: configFileName,
        gitignore_existed: gitignore.gitignore_existed,
        gitignore_updated: gitignore.gitignore_updated,
        previous_project_id: previousProjectId,
      };
    }
  }

  const newConfig = ProjectConfigSchema.parse({
    version: 1,
    project_id: randomUUID(),
    project_name: options.projectName?.trim() || path.basename(projectRoot) || "project",
    created_at: new Date().toISOString(),
    default_verification_command: options.defaultVerificationCommand ?? null,
    auto_run_verification: options.autoRunVerification ?? true,
    verification_timeout_ms: options.verificationTimeoutMs ?? 60000,
    max_attempts: options.maxAttempts ?? 3,
    lease_timeout_minutes: options.leaseTimeoutMinutes ?? 30,
    require_verification_note: options.requireVerificationNote ?? true,
  });

  writeFileAtomic(configPath, `${JSON.stringify(newConfig, null, 2)}\n`);
  const gitignore = ensureGitignoreEntry(projectRoot, configFileName);

  return {
    config: newConfig,
    project_root: projectRoot,
    config_path: configPath,
    config_file_name: configFileName,
    gitignore_existed: gitignore.gitignore_existed,
    gitignore_updated: gitignore.gitignore_updated,
    previous_project_id: previousProjectId,
  };
}

/**
 * Resolves the project config by traversing upward from startPath (or fallback dir).
 * Stops at filesystem root, $HOME, or after checking the nearest .git root so it never
 * leaks into an unrelated parent workspace.
 */
export function resolveProjectConfig(
  startPath?: string,
  configFileName?: string
): ResolvedProject {
  const effectiveConfigName = sanitizeConfigFileName(configFileName);
  const rawStart =
    startPath?.trim() ||
    process.env.MOEX_PROJECT_DIR?.trim() ||
    process.env.MCP_TASKLIST_PROJECT_DIR?.trim() ||
    process.cwd();

  const resolvedInput = path.resolve(rawStart);
  if (!existsSync(resolvedInput)) {
    throw new TasklistError(
      "INVALID_PATH",
      `Provided project_path does not exist: "${resolvedInput}".`
    );
  }

  const inputStat = statSync(resolvedInput);
  let currentDir = inputStat.isDirectory() ? resolvedInput : path.dirname(resolvedInput);
  const fsRoot = path.parse(currentDir).root;
  const homeDir = path.resolve(os.homedir());

  while (true) {
    if (currentDir === fsRoot || currentDir === homeDir) {
      break;
    }

    const candidate = path.join(currentDir, effectiveConfigName);
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      let rawJson: unknown;
      try {
        rawJson = JSON.parse(readFileSync(candidate, "utf8"));
      } catch (err) {
        throw new TasklistError(
          "INVALID_PROJECT_CONFIG",
          `Failed to parse "${candidate}" as JSON: ${
            err instanceof Error ? err.message : String(err)
          }`,
          { config_path: candidate }
        );
      }

      const parsed = ProjectConfigSchema.safeParse(rawJson);
      if (!parsed.success) {
        throw new TasklistError(
          "INVALID_PROJECT_CONFIG",
          `Invalid project config at "${candidate}": ${parsed.error.message}`,
          { config_path: candidate }
        );
      }

      return {
        config: parsed.data,
        project_root: currentDir,
        config_path: candidate,
        config_file_name: effectiveConfigName,
      };
    }

    // Do not climb above a git repository root if the repo itself wasn't initialized
    if (existsSync(path.join(currentDir, ".git"))) {
      break;
    }

    const parent = path.dirname(currentDir);
    if (parent === currentDir) {
      break;
    }
    currentDir = parent;
  }

  throw new TasklistError(
    "PROJECT_NOT_INITIALIZED",
    `Project is not initialized (missing "${effectiveConfigName}" starting from "${resolvedInput}"). Run "moex init" inside the project root directory first, or pass the initialized project_path.`,
    {
      searched_from: resolvedInput,
      expected_config_file: effectiveConfigName,
      init_command:
        effectiveConfigName === DEFAULT_CONFIG_FILENAME
          ? `moex init --dir "${resolvedInput}"`
          : `moex init --dir "${resolvedInput}" --config "${effectiveConfigName}"`,
    }
  );
}

/**
 * Resolves the canonical filesystem path for absPath by finding the deepest existing
 * ancestor via realpathSync and reattaching any not-yet-created trailing segments.
 */
function resolveThroughExistingAncestor(absPath: string): string {
  const trailing: string[] = [];
  let cursor = path.resolve(absPath);

  while (!existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      return cursor;
    }
    trailing.unshift(path.basename(cursor));
    cursor = parent;
  }

  const realBase = realpathSync(cursor);
  return trailing.length > 0 ? path.join(realBase, ...trailing) : realBase;
}

function isEscapingRelativePath(rel: string): boolean {
  return (
    rel === "" ||
    rel === "." ||
    rel === ".." ||
    rel.startsWith(`..${path.sep}`) ||
    path.isAbsolute(rel)
  );
}

/**
 * Normalizes file paths to clean relative POSIX paths rooted at projectRoot.
 * Rejects both lexical path traversal and symlinks pointing outside projectRoot.
 */
export function normalizeRepoPaths(
  projectRoot: string,
  paths: readonly string[]
): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  const realRoot = existsSync(projectRoot)
    ? realpathSync(projectRoot)
    : path.resolve(projectRoot);

  for (const raw of paths) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    const absTarget = path.isAbsolute(trimmed)
      ? path.resolve(trimmed)
      : path.resolve(projectRoot, trimmed);
    const lexicalRel = path.relative(projectRoot, absTarget);
    if (isEscapingRelativePath(lexicalRel)) {
      throw new TasklistError(
        "INVALID_PATH",
        `File path "${raw}" escapes project root "${projectRoot}" or refers to root itself.`
      );
    }

    const realTarget = resolveThroughExistingAncestor(absTarget);
    const realRel = path.relative(realRoot, realTarget);
    if (isEscapingRelativePath(realRel)) {
      throw new TasklistError(
        "INVALID_PATH",
        `File path "${raw}" resolves via symlink outside project root "${projectRoot}".`
      );
    }

    const posixRel = lexicalRel.split(path.sep).join("/");
    if (!seen.has(posixRel)) {
      seen.add(posixRel);
      normalized.push(posixRel);
    }
  }

  return normalized;
}

const GLOB_META_REGEX = /[*?[\]{}]/;

function hasGlobMeta(p: string): boolean {
  return GLOB_META_REGEX.test(p);
}

function globStaticPrefix(pattern: string): string {
  const parts = pattern.split("/");
  const prefixParts: string[] = [];
  for (const part of parts) {
    if (hasGlobMeta(part)) break;
    prefixParts.push(part);
  }
  return prefixParts.join("/");
}

function isPathNested(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * Checks whether two normalized relative POSIX repo paths (files, directories, or globs)
 * overlap and could cause parallel subagents to edit conflicting targets.
 */
export function doRepoPathsConflict(pathA: string, pathB: string): boolean {
  const a = pathA.replace(/\/+$/, "");
  const b = pathB.replace(/\/+$/, "");
  if (!a || !b) return false;
  if (a === b) return true;

  const aGlob = hasGlobMeta(a);
  const bGlob = hasGlobMeta(b);

  if (!aGlob && !bGlob) {
    return isPathNested(a, b);
  }

  if (aGlob && !bGlob) {
    if (new Bun.Glob(a).match(b)) return true;
    const prefixA = globStaticPrefix(a);
    return prefixA.length > 0 && (prefixA === b || prefixA.startsWith(`${b}/`));
  }

  if (!aGlob && bGlob) {
    if (new Bun.Glob(b).match(a)) return true;
    const prefixB = globStaticPrefix(b);
    return prefixB.length > 0 && (prefixB === a || prefixB.startsWith(`${a}/`));
  }

  // Both paths contain glob wildcards
  const prefixA = globStaticPrefix(a);
  const prefixB = globStaticPrefix(b);
  if (new Bun.Glob(a).match(b) || new Bun.Glob(b).match(a)) return true;
  if (prefixA && new Bun.Glob(b).match(prefixA)) return true;
  if (prefixB && new Bun.Glob(a).match(prefixB)) return true;
  if (prefixA && prefixB && (a.includes("**") || b.includes("**"))) {
    return isPathNested(prefixA, prefixB);
  }
  return prefixA.length > 0 && prefixA === prefixB;
}
