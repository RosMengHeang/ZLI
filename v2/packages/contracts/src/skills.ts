import { z } from "zod";

import { ProjectId } from "./ids.js";
import { type ListedProviderKind, ProviderKind } from "./provider.js";

/** Where a project's shared skills live, relative to the repository root. Committed so the team gets them. */
export const PROJECT_SKILLS_DIR = ".agents/skills";
export const SKILL_FILE = "SKILL.md";
export const MAX_SKILL_NAME = 64;
export const MAX_SKILL_DESCRIPTION = 1_024;
export const MAX_SKILL_INSTRUCTIONS = 200_000;

/**
 * The folders each agent reads skills from, relative to the home folder (user) and the repository root
 * (project). Kimi's `.kimi-code` moves with KIMI_CODE_HOME. Only folders the agents document are listed:
 * - Claude Code: https://code.claude.com/docs/en/skills
 * - Codex: https://developers.openai.com/codex/skills
 * - Cursor: https://cursor.com/docs/skills
 * - Droid: https://docs.factory.ai/cli/configuration/skills
 * - OpenCode: https://opencode.ai/docs/skills/
 * - Gemini: https://geminicli.com/docs/cli/skills/
 * - Copilot: https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills
 * - Kimi Code: https://www.kimi.com/code/docs/en/kimi-code-cli/customization/skills.html
 * - Qwen Code: https://qwenlm.github.io/qwen-code-docs/en/users/features/skills/
 * - Goose: https://goose-docs.ai/docs/guides/context-engineering/using-skills/
 */
export const AGENT_SKILL_DIRS: Record<ListedProviderKind, { user: readonly string[]; project: readonly string[] }> = {
  "claude-code": { user: [".claude/skills"], project: [".claude/skills"] },
  codex: { user: [".agents/skills"], project: [".agents/skills"] },
  "cursor-agent": {
    user: [".cursor/skills", ".agents/skills", ".claude/skills", ".codex/skills"],
    project: [".cursor/skills", ".agents/skills", ".claude/skills", ".codex/skills"],
  },
  droid: { user: [".factory/skills", ".agents/skills"], project: [".factory/skills", ".agents/skills"] },
  opencode: {
    user: [".config/opencode/skills", ".claude/skills", ".agents/skills"],
    project: [".opencode/skills", ".claude/skills", ".agents/skills"],
  },
  gemini: { user: [".gemini/skills", ".agents/skills"], project: [".gemini/skills", ".agents/skills"] },
  copilot: {
    user: [".copilot/skills", ".agents/skills"],
    project: [".github/skills", ".claude/skills", ".agents/skills"],
  },
  kimi: { user: [".kimi-code/skills", ".agents/skills"], project: [".kimi-code/skills", ".agents/skills"] },
  qwen: { user: [".qwen/skills", ".agents/skills"], project: [".qwen/skills", ".agents/skills"] },
  goose: {
    user: [".agents/skills", ".claude/skills"],
    project: [".agents/skills", ".goose/skills", ".claude/skills"],
  },
};

/** Agents that read a folder, in the order of the table. */
export function agentsReading(scope: "user" | "project", dir: string): ListedProviderKind[] {
  return ProviderKind.options.filter((provider) => AGENT_SKILL_DIRS[provider][scope].includes(dir));
}

/** Why a name breaks the Agent Skills rule (https://agentskills.io/specification), or undefined. */
export function skillNameProblem(name: string): string | undefined {
  if (name.length === 0) return "Add a name.";
  if (name.length > MAX_SKILL_NAME) return `Names are at most ${MAX_SKILL_NAME} characters.`;
  if (!/^[a-z0-9-]+$/u.test(name)) return "Names use lowercase letters, digits, and hyphens.";
  if (name.startsWith("-") || name.endsWith("-")) return "Names do not start or end with a hyphen.";
  if (name.includes("--")) return "Names do not have two hyphens in a row.";
  return undefined;
}

export const SkillName = z.string().superRefine((name, context) => {
  const problem = skillNameProblem(name);
  if (problem) context.addIssue({ code: "custom", message: problem });
});

/** A folder that holds a skill, which may predate the naming rule. Never a path. */
export const SkillFolderName = z
  .string()
  .min(1)
  .max(255)
  .refine((name) => !/[/\\\0]/u.test(name) && name !== "." && name !== "..", "Not a skill folder name.");

export const SkillDraft = z.object({
  name: SkillName,
  description: z
    .string()
    .trim()
    .min(1, "Add a description so agents know when to use the skill.")
    .max(MAX_SKILL_DESCRIPTION, `Descriptions are at most ${MAX_SKILL_DESCRIPTION} characters.`),
  instructions: z.string().max(MAX_SKILL_INSTRUCTIONS, "The instructions are too long."),
});
export type SkillDraft = z.infer<typeof SkillDraft>;

export const SkillScope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user") }),
  z.object({ kind: z.literal("project"), projectId: ProjectId }),
]);
export type SkillScope = z.infer<typeof SkillScope>;

/** A GitHub folder URL such as https://github.com/owner/repo/tree/main/skills, or owner/repo with an optional path. */
export const SkillSource = z.string().trim().min(1, "Paste a GitHub link or owner/repo.").max(1_000);

/** The project whose skills a reply lists, besides the person's own. */
const ListContext = { projectId: ProjectId.optional() };

/** Handled directly by the runtime server; none of these reach the event log. */
export const SkillCommand = z.discriminatedUnion("type", [
  z.object({ type: z.literal("skills.list"), ...ListContext }),
  z.object({ type: z.literal("skills.read"), scope: SkillScope, name: SkillFolderName }),
  z.object({
    type: z.literal("skills.save"),
    scope: SkillScope,
    /** The folder being edited. Absent for a new skill. */
    previousName: SkillFolderName.optional(),
    skill: SkillDraft,
    ...ListContext,
  }),
  z.object({ type: z.literal("skills.delete"), scope: SkillScope, name: SkillFolderName, ...ListContext }),
  z.object({ type: z.literal("skills.setEnabled"), name: SkillFolderName, enabled: z.boolean(), ...ListContext }),
  z.object({ type: z.literal("skills.previewInstall"), source: SkillSource, scope: SkillScope.optional() }),
  z.object({
    type: z.literal("skills.install"),
    source: SkillSource,
    scope: SkillScope,
    names: z.array(SkillName).min(1).max(200),
    ...ListContext,
  }),
]);
export type SkillCommand = z.infer<typeof SkillCommand>;
export const SKILL_COMMAND_TYPES = [
  "skills.list",
  "skills.read",
  "skills.save",
  "skills.delete",
  "skills.setEnabled",
  "skills.previewInstall",
  "skills.install",
] as const;

export const SkillSummary = z.object({
  /** The folder name, which agents also use as the skill's name. */
  name: z.string(),
  description: z.string(),
  scope: z.enum(["user", "project"]),
  /** Project skills are always on: agents read them straight from the repository. */
  enabled: z.boolean(),
  path: z.string(),
  /** Where the skill was installed from. */
  source: z.string().optional(),
  /** Why agents may not load it, for example a missing description. */
  problem: z.string().optional(),
  /** Skills folders in worktrees where a skill of the same name kept ZLI's copy out. */
  conflicts: z.array(z.string()).optional(),
});
export type SkillSummary = z.infer<typeof SkillSummary>;

/** A skill already in an agent's own folder. ZLI lists it and leaves it alone. */
export const FoundSkill = z.object({
  name: z.string(),
  description: z.string(),
  scope: z.enum(["user", "project"]),
  path: z.string(),
  /** The folder the skill sits in, as written in AGENT_SKILL_DIRS. */
  dir: z.string(),
  agents: z.array(ProviderKind),
  problem: z.string().optional(),
});
export type FoundSkill = z.infer<typeof FoundSkill>;

/** A worktree skills folder where ZLI could not copy every enabled skill. */
export const SkillSyncOutcome = z.object({
  path: z.string(),
  agents: z.array(ProviderKind),
  status: z.enum(["unchanged", "failed"]),
  /** Skills ZLI did not copy because the folder already has a skill with that name. */
  conflicts: z.array(z.string()),
  message: z.string().optional(),
});
export type SkillSyncOutcome = z.infer<typeof SkillSyncOutcome>;

export const SkillListResult = z.object({
  skills: z.array(SkillSummary),
  found: z.array(FoundSkill),
  /** Where ZLI keeps the person's skills before copying them into worktrees. */
  libraryPath: z.string(),
  sync: z.object({ enabled: z.boolean(), outcomes: z.array(SkillSyncOutcome) }),
  project: z.object({ projectId: ProjectId, path: z.string(), skillsPath: z.string() }).optional(),
  /** Set when ZLI's skill settings could not be read; saving replaces them. */
  problem: z.string().optional(),
});
export type SkillListResult = z.infer<typeof SkillListResult>;

export const SkillDocument = z.object({
  name: z.string(),
  description: z.string(),
  instructions: z.string(),
  scope: z.enum(["user", "project"]),
  path: z.string(),
  /** Other files in the folder, relative to it, with forward slashes. Saving keeps them. */
  files: z.array(z.string()),
});
export type SkillDocument = z.infer<typeof SkillDocument>;

export const SkillInstallCandidate = z.object({
  name: z.string(),
  description: z.string(),
  /** The folder in the repository. */
  path: z.string(),
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  /** A skill with this name is already there and installing replaces it. */
  exists: z.boolean(),
  /** Why it cannot be installed. */
  problem: z.string().optional(),
});
export type SkillInstallCandidate = z.infer<typeof SkillInstallCandidate>;

export const SkillInstallPreview = z.object({
  owner: z.string(),
  repo: z.string(),
  ref: z.string().optional(),
  path: z.string(),
  candidates: z.array(SkillInstallCandidate),
});
export type SkillInstallPreview = z.infer<typeof SkillInstallPreview>;

export const SkillInstallResult = SkillListResult.extend({ installed: z.array(z.string()) });
export type SkillInstallResult = z.infer<typeof SkillInstallResult>;
