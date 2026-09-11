import type { AppError } from "../types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringifyDetails(details: unknown): string | undefined {
  if (details === undefined || details === null) return undefined;
  if (typeof details === "string") return details;
  try {
    return JSON.stringify(details);
  } catch {
    return String(details);
  }
}

function messageFromGitError(kind: string, details: unknown): string {
  if (!isRecord(details)) return kind;
  switch (kind) {
    case "notGitRepository":
      return `'${details.path}' is not a Git repository`;
    case "dirtyWorktree":
      return `Uncommitted changes at '${details.path}': ${details.message ?? ""}`.trim();
    case "branchExists":
      return `Branch '${details.branch}' already exists`;
    case "worktreeExists":
      return `A worktree already exists at '${details.path}'`;
    case "worktreeNotFound":
      return `No worktree found at '${details.path}'`;
    case "worktreeInUse":
      return `Worktree '${details.path}' is still in use. Stop its terminal before removing it.`;
    case "branchNotFound":
      return `Branch '${details.branch}' was not found`;
    case "invalidPath":
      return `Invalid path '${details.path}': ${details.reason ?? ""}`.trim();
    case "invalidInput":
      return String(details.message ?? "Invalid input");
    case "mergeConflict":
      return `Merge conflict: '${details.sourceBranch}' into '${details.targetBranch}' (${
        Array.isArray(details.conflictedFiles) ? details.conflictedFiles.length : 0
      } files)`;
    case "nothingToCommit":
      return `Nothing to commit at '${details.path}'`;
    case "gitCommandFailed":
      return `'${details.command}' failed: ${details.message ?? ""}`.trim();
    case "io":
      return `Filesystem error: ${details.message ?? ""}`.trim();
    default:
      return stringifyDetails(details) ?? kind;
  }
}

export function toAppError(err: unknown): AppError {
  if (isAppError(err)) return err;

  if (typeof err === "string") {
    const parsed = tryParseJson(err);
    if (parsed) return toAppError(parsed);
    return { code: classifyMissing(err), message: err };
  }

  if (isRecord(err)) {
    if (typeof err.kind === "string") {
      if (typeof err.message === "string" && err.details === undefined) {
        return { code: err.kind, message: err.message };
      }
      return {
        code: err.kind,
        message: messageFromGitError(err.kind, err.details),
        details: stringifyDetails(err.details),
      };
    }
    if (typeof err.code === "string" && typeof err.message === "string") {
      return { code: err.code, message: err.message, details: stringifyDetails(err.details) };
    }
    if (typeof err.message === "string") {
      const nested = err.error ?? err.data ?? err.payload;
      if (nested && nested !== err) {
        const inner = toAppError(nested);
        if (inner.code !== "unknown") return inner;
      }
      return { code: classifyMissing(err.message), message: err.message };
    }
  }

  return { code: "unknown", message: err instanceof Error ? err.message : String(err) };
}

export function isAppError(value: unknown): value is AppError {
  return isRecord(value) && typeof value.code === "string" && typeof value.message === "string";
}

export function isCommandMissing(err: AppError): boolean {
  return (
    err.code === "command_not_found" ||
    /command not found|unknown command|not allowed|Command \S+ not found/i.test(err.message)
  );
}

function classifyMissing(message: string): string {
  if (/command not found|unknown command|not allowed/i.test(message)) {
    return "command_not_found";
  }
  if (/plugin|dialog/i.test(message) && /not|missing|unavailable/i.test(message)) {
    return "plugin_unavailable";
  }
  return "ipc";
}

function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}
