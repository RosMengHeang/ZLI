import { z } from "zod";

import { MobileControlDeviceInput } from "./mobile.js";

/** What a proposed command argument may contain. Quotes, spaces, and shell operators are refused, not escaped. */
export const SAFE_ARG = /^[A-Za-z0-9@._/:=+,%^~-]{1,300}$/u;

/** The only programs a proposal can run. */
export const PROPOSAL_PROGRAMS = [
  "npx",
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "expo",
  "eas",
  "./gradlew",
  "gradlew.bat",
  "pod",
  "bundle",
  "flutter",
  "adb",
  "xcrun",
] as const;
export const ProposalProgram = z.enum(PROPOSAL_PROGRAMS);
export type ProposalProgram = z.infer<typeof ProposalProgram>;

export const PROPOSAL_ENV_KEYS = ["CI", "EXPO_NO_TELEMETRY"] as const;

/** The files a proposal may write a block into, and the marker around ZLI's block. */
export const PROPOSAL_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
export const PROPOSAL_BLOCK_START = "<!-- zli:mobile:start -->";
export const PROPOSAL_BLOCK_END = "<!-- zli:mobile:end -->";

export const MobileProposalAction = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("command"),
    program: ProposalProgram,
    args: z.array(z.string().regex(SAFE_ARG)).max(32),
    /** Relative to the worktree root, with no "..". */
    cwd: z.string().max(300).default("."),
    /** Extra environment for this command only, such as CI=1. */
    env: z.partialRecord(z.enum(PROPOSAL_ENV_KEYS), z.literal("1")).optional(),
  }),
  z.object({
    kind: z.literal("file-block"),
    file: z.enum(PROPOSAL_FILES),
    marker: z.literal("zli:mobile"),
    /** The new text between the markers. */
    content: z.string().max(8_000),
    /** sha256 hex of the whole file when the proposal was made, or "absent". Writing refuses if it changed. */
    baseDigest: z.string().max(80),
  }),
]);
export type MobileProposalAction = z.infer<typeof MobileProposalAction>;
export type MobileProposalActionInput = z.input<typeof MobileProposalAction>;
export type MobileProposalCommand = Extract<MobileProposalAction, { kind: "command" }>;

export const MobileProposalState = z.enum(["pending", "started", "written", "dismissed", "failed"]);
export type MobileProposalState = z.infer<typeof MobileProposalState>;

/** A command or file change ZLI shows the person, which runs only when they choose to run or write it. */
export const MobileProposal = z.object({
  proposalId: z.string().uuid(),
  worktreeId: z.string().min(1).max(200),
  source: z.enum(["zli", "agent"]),
  /** Shown as is above the title, such as "Proposed by the agent in feat-login" or "From the project check". */
  sourceLabel: z.string().max(120),
  title: z.string().min(1).max(120),
  reason: z.string().max(600),
  action: MobileProposalAction,
  state: MobileProposalState,
  error: z.string().max(500).optional(),
  terminalId: z.string().optional(),
  createdAt: z.string().datetime({ offset: true }),
});
export type MobileProposal = z.infer<typeof MobileProposal>;
export const MobileProposalList = z.array(MobileProposal).max(2_000);

export const MobileProposalIdInput = z.object({ proposalId: z.string().uuid() });
export type MobileProposalIdInput = z.infer<typeof MobileProposalIdInput>;

export const MobileProposalListInput = z.object({ worktreeId: z.string().min(1).max(200).optional() });
export type MobileProposalListInput = z.infer<typeof MobileProposalListInput>;

/**
 * mobile_propose from an agent. `folder` is where the command runs, relative to the worktree; `cwd` stays the
 * agent's own directory, which picks the worktree as it does for every zli-mobile tool.
 */
export const MobileControlProposeInput = MobileControlDeviceInput.extend({
  title: z.string().trim().min(1).max(120),
  reason: z.string().max(600).default(""),
  program: ProposalProgram,
  args: z.array(z.string().regex(SAFE_ARG)).max(32).default([]),
  folder: z.string().max(300).optional(),
});
export type MobileControlProposeInput = z.infer<typeof MobileControlProposeInput>;

/** The command line as the person reads it on the card. Arguments never contain spaces or quotes. */
export function proposalCommandLine(action: Pick<MobileProposalCommand, "program" | "args" | "env">): string {
  const env = Object.entries(action.env ?? {}).map(([key, value]) => `${key}=${value}`);
  return [...env, action.program, ...action.args].join(" ");
}

/** The e2e test hook: one named operation and its input. Only a mock test launch with the fake mobile service has it. */
export const MobileTestInput = z.object({ op: z.string().min(1).max(60), input: z.unknown().optional() });
export type MobileTestInput = z.infer<typeof MobileTestInput>;

/** e2e: propose a command as the agent in a worktree would. Without worktreeId, the first ready worktree. */
export const MobileTestProposeInput = z.object({
  worktreeId: z.string().optional(),
  title: z.string().min(1).max(120).default("Run a command"),
  reason: z.string().max(600).default(""),
  program: ProposalProgram,
  args: z.array(z.string().regex(SAFE_ARG)).max(32).default([]),
  folder: z.string().max(300).optional(),
});

/** e2e: propose a block for AGENTS.md or CLAUDE.md, against the file as it is now. */
export const MobileTestProposeFileInput = z.object({
  worktreeId: z.string().optional(),
  title: z.string().min(1).max(120).default("Add mobile notes for agents"),
  reason: z.string().max(600).default(""),
  file: z.enum(PROPOSAL_FILES).default("AGENTS.md"),
  content: z.string().max(8_000),
});

/** e2e: what the fake process runner answers for commands whose line contains match. The newest answer wins. */
export const MobileTestRunnerAnswer = z.object({
  match: z.string().min(1).max(500),
  answer: z.object({
    code: z.number().int().nullable().default(0),
    stdout: z.string().max(1_000_000).default(""),
    stderr: z.string().max(1_000_000).default(""),
    timedOut: z.boolean().default(false),
  }),
});
export type MobileTestRunnerAnswer = z.infer<typeof MobileTestRunnerAnswer>;

/** e2e: what the fake fetch answers for a URL. Unanswered URLs get a 404. */
export const MobileTestFetchAnswer = z.object({
  url: z.string().url().max(2_000),
  status: z.number().int().min(100).max(599).default(200),
  json: z.unknown(),
});
export type MobileTestFetchAnswer = z.infer<typeof MobileTestFetchAnswer>;

// Types more than one feature uses, so each can be built on its own. Features may add optional fields only.

export const MobileFinding = z.object({
  id: z.string().max(80),
  severity: z.enum(["error", "warning", "info"]),
  title: z.string().max(200),
  detail: z.string().max(1_000),
  fix: MobileProposalAction.optional(),
  source: z.string().url().optional(),
});
export type MobileFinding = z.infer<typeof MobileFinding>;

export const MobileProjectFactsCore = z.object({
  worktreeId: z.string(),
  /** Relative to the worktree, "." for its root. */
  appDir: z.string(),
  stack: z.enum(["expo", "react-native", "flutter", "android", "ios", "none"]),
  /** Such as { expo: "56.0.3", "react-native": "0.85.1", java: "17.0.12" }. */
  versions: z.record(z.string().max(60), z.string().max(60)),
  findings: z.array(MobileFinding).max(50),
  fingerprint: z.string().max(40),
  checkedAt: z.string().datetime({ offset: true }),
});
export type MobileProjectFactsCore = z.infer<typeof MobileProjectFactsCore>;
