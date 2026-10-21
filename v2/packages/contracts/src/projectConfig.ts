import { z } from "zod";

import { ProjectId, TerminalId, WorktreeId } from "./ids.js";

/** The team-shared project file at the repository root. */
export const ZLI_CONFIG_FILE = "zli.json";
export const MAX_ZLI_CONFIG_BYTES = 256 * 1024;

/**
 * Why a copy pattern is unsafe, or undefined when it is fine. Patterns are relative to the repository
 * root, use forward slashes, and never leave the repository.
 */
export function repoPatternProblem(pattern: string): string | undefined {
  if (pattern.trim() !== pattern || pattern.length === 0) return "must not be empty or start or end with spaces";
  if (pattern.includes("\0")) return "must not contain NUL characters";
  if (pattern.includes("\\")) return "must use forward slashes";
  if (pattern.startsWith("/") || /^[A-Za-z]:/u.test(pattern)) return "must be relative to the repository root";
  if (pattern.startsWith("!")) return "cannot be a negation";
  const parts = pattern.split("/");
  if (parts.some((part) => part === "..")) return "must not contain '..'";
  if (parts.some((part) => part === "")) return "must not contain empty path segments";
  if (parts[0] === ".git" || parts[0] === ".") return "must name a path inside the repository";
  return undefined;
}

const RepoPattern = z
  .string()
  .max(500)
  .superRefine((value, context) => {
    const problem = repoPatternProblem(value);
    if (problem) context.addIssue({ code: "custom", message: `"${value}" ${problem}` });
  });

const SetupCommand = z
  .string()
  .min(1, "Setup commands must not be empty")
  .max(4_000)
  .refine((value) => value.trim().length > 0, "Setup commands must not be empty")
  .refine((value) => !/[\0\r\n]/u.test(value), "Put each setup command on its own line in the list");

export const SharedPrompt = z.strictObject({
  name: z.string().trim().min(1, "Prompt names must not be empty").max(80),
  prompt: z.string().min(1, "Prompts must not be empty").max(20_000),
});
export type SharedPrompt = z.infer<typeof SharedPrompt>;

export const ZliConfig = z.strictObject({
  $schema: z.string().max(2_000).optional(),
  version: z.literal(1, "version must be 1"),
  worktree: z
    .strictObject({
      /** Files or globs copied from the main checkout into each new worktree, such as `.env`. */
      copy: z.array(RepoPattern).max(100).optional(),
      /** Shell commands run in order inside each new worktree after the copy. */
      setup: z.array(SetupCommand).max(20).optional(),
    })
    .optional(),
  prompts: z.array(SharedPrompt).max(100).optional(),
});
export type ZliConfig = z.infer<typeof ZliConfig>;

export type ZliConfigParse = { ok: true; config: ZliConfig } | { ok: false; message: string };

/** Parses the text of a zli.json file. The message names the field that failed, for example `worktree.copy.0`. */
export function parseZliConfig(text: string): ZliConfigParse {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      message: `zli.json is not valid JSON: ${error instanceof Error ? error.message : "parse error"}`,
    };
  }
  const result = ZliConfig.safeParse(value);
  if (result.success) return { ok: true, config: result.data };
  const issues = result.error.issues.slice(0, 3).map((issue) => {
    const path = issue.path.map(String).join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  const more = result.error.issues.length > 3 ? ` (${result.error.issues.length - 3} more)` : "";
  return { ok: false, message: `zli.json is invalid. ${issues.join("; ")}${more}` };
}

/** Answer to the `project.config` query. Read fresh from the project folder on every request. */
export const ProjectConfigResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("missing") }),
  z.object({ status: z.literal("valid"), config: ZliConfig, commandsHash: z.string().optional() }),
  z.object({ status: z.literal("invalid"), message: z.string().min(1) }),
]);
export type ProjectConfigResult = z.infer<typeof ProjectConfigResult>;

/**
 * - copying: copying the listed files from the main checkout
 * - waiting: the setup commands need the person's approval before they run
 * - running: a setup command runs in a terminal, `commandIndex` says which
 * - succeeded, failed, skipped: finished; failed carries the command index and exit code
 * - invalid: zli.json could not be read, so nothing was copied or run
 */
export const WorktreeSetupStatus = z.enum([
  "copying",
  "waiting",
  "running",
  "succeeded",
  "failed",
  "skipped",
  "invalid",
]);
export type WorktreeSetupStatus = z.infer<typeof WorktreeSetupStatus>;

export const WorktreeSetupProjection = z.object({
  worktreeId: WorktreeId,
  projectId: ProjectId,
  status: WorktreeSetupStatus,
  commands: z.array(z.string()),
  commandsHash: z.string(),
  copied: z.array(z.string()),
  skipped: z.array(z.object({ entry: z.string(), reason: z.string() })),
  commandIndex: z.number().int().nonnegative().optional(),
  terminalId: TerminalId.optional(),
  exitCode: z.number().int().optional(),
  errorMessage: z.string().min(1).optional(),
});
export type WorktreeSetupProjection = z.infer<typeof WorktreeSetupProjection>;

/** The person allowed this exact list of setup commands to run in every new worktree of the project. */
export const SetupTrustProjection = z.object({
  projectId: ProjectId,
  commandsHash: z.string().min(1),
  trustedAt: z.string().datetime({ offset: true }),
});
export type SetupTrustProjection = z.infer<typeof SetupTrustProjection>;

export const SetupDecision = z.enum(["run-once", "always", "skip"]);
export type SetupDecision = z.infer<typeof SetupDecision>;
