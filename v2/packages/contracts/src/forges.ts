import { z } from "zod";

/** A forge: where a repository is hosted. Each is driven by its own CLI, signed in with the person's account. */
export const ForgeKind = z.enum(["github", "gitlab", "gitea"]);
export type ForgeKind = z.infer<typeof ForgeKind>;

export const ForgeCli = z.enum(["gh", "glab", "tea"]);
export type ForgeCli = z.infer<typeof ForgeCli>;

/** One server the CLI is signed in to, and the account on it when the CLI says. */
export const ForgeAccount = z.object({
  host: z.string().min(1).max(253),
  login: z.string().min(1).max(200).optional(),
});
export type ForgeAccount = z.infer<typeof ForgeAccount>;

/**
 * What ZLI found for one forge's CLI. missing: not on PATH. outdated: older than ZLI needs. signed_out: installed
 * with no account. ready: signed in to at least one server. error: it ran but its answer could not be read.
 */
export const ForgeCliStatus = z.object({
  kind: ForgeKind,
  label: z.string().min(1).max(40),
  cli: ForgeCli,
  state: z.enum(["missing", "outdated", "signed_out", "ready", "error"]),
  version: z.string().min(1).max(40).optional(),
  minimumVersion: z.string().min(1).max(40),
  accounts: z.array(ForgeAccount).max(50),
  /** The command that signs the CLI in, to copy into a terminal. */
  signInCommand: z.string().min(1).max(200),
  installUrl: z.string().url(),
  message: z.string().min(1).max(2_000).optional(),
});
export type ForgeCliStatus = z.infer<typeof ForgeCliStatus>;

export const ForgeStatusResult = z.object({
  forges: z.array(ForgeCliStatus).max(10),
  checkedAt: z.string().min(1).max(100),
});
export type ForgeStatusResult = z.infer<typeof ForgeStatusResult>;

export const ForgeCommand = z.discriminatedUnion("type", [
  /** Each forge CLI's status, as last checked. */
  z.object({ type: z.literal("forges.status") }),
  /** Checks every forge CLI again, for after the person installs or signs in to one. */
  z.object({ type: z.literal("forges.rescan") }),
]);
export type ForgeCommand = z.infer<typeof ForgeCommand>;
export const FORGE_COMMAND_TYPES = [
  "forges.status",
  "forges.rescan",
] as const satisfies readonly ForgeCommand["type"][];
