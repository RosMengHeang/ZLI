import { z } from "zod";

import { skillNameProblem } from "./skills.js";

/** Manifests ZLI reads, in the order it looks for them in a plugin folder. */
export const PLUGIN_MANIFESTS = [
  { path: "zli-plugin.json", format: "zli" },
  { path: ".claude-plugin/plugin.json", format: "claude" },
  { path: ".codex-plugin/plugin.json", format: "codex" },
] as const;
/** Catalogs that list several plugins in one repository. */
export const PLUGIN_MARKETPLACES = [".claude-plugin/marketplace.json", ".agents/plugins/marketplace.json"] as const;

export const PluginFormat = z.enum(["zli", "claude", "codex", "folder"]);
export type PluginFormat = z.infer<typeof PluginFormat>;

/** Plugin names follow the same rule as skill names, since both become folder names agents read. */
export const PluginName = z.string().superRefine((name, context) => {
  const problem = skillNameProblem(name);
  if (problem) context.addIssue({ code: "custom", message: problem });
});

/** A GitHub link, owner/repo with an optional path, or an absolute folder path on this computer. */
export const PluginSource = z.string().trim().min(1, "Paste a GitHub link, owner/repo, or a folder path.").max(2_000);

export const PluginConfigOption = z.object({
  key: z.string(),
  title: z.string(),
  description: z.string().optional(),
  type: z.enum(["string", "number", "boolean", "directory", "file"]),
  sensitive: z.boolean(),
  required: z.boolean(),
  default: z.string().optional(),
});
export type PluginConfigOption = z.infer<typeof PluginConfigOption>;

export const PluginComponents = z.object({
  skills: z.array(z.string()),
  mcpServers: z.array(z.string()),
  prompts: z.array(z.object({ name: z.string(), description: z.string() })),
  actions: z.array(z.object({ name: z.string(), description: z.string(), command: z.string() })),
  /** Parts only Claude Code or Codex understand, such as hooks and subagents. ZLI lists them and leaves them out. */
  ignored: z.array(z.string()),
});
export type PluginComponents = z.infer<typeof PluginComponents>;

const ConfigValues = z.record(z.string().max(200), z.string().max(8_000));

/** Handled directly by the runtime server; none of these reach the event log. */
export const PluginCommand = z.discriminatedUnion("type", [
  z.object({ type: z.literal("plugins.list") }),
  z.object({ type: z.literal("plugins.previewInstall"), source: PluginSource }),
  z.object({
    type: z.literal("plugins.install"),
    source: PluginSource,
    names: z.array(PluginName).min(1).max(50),
    /** Values for each plugin's settings, by plugin name. */
    config: z.record(z.string(), ConfigValues).optional(),
  }),
  z.object({ type: z.literal("plugins.setEnabled"), name: PluginName, enabled: z.boolean() }),
  /** Blank values keep what is saved, so a secret never has to be shown again to keep it. */
  z.object({ type: z.literal("plugins.configure"), name: PluginName, values: ConfigValues }),
  z.object({ type: z.literal("plugins.update"), name: PluginName }),
  z.object({ type: z.literal("plugins.remove"), name: PluginName }),
  /** Prompts and actions from enabled plugins, for the "/" list and the command palette. */
  z.object({ type: z.literal("plugins.contributions") }),
]);
export type PluginCommand = z.infer<typeof PluginCommand>;
export const PLUGIN_COMMAND_TYPES = [
  "plugins.list",
  "plugins.previewInstall",
  "plugins.install",
  "plugins.setEnabled",
  "plugins.configure",
  "plugins.update",
  "plugins.remove",
  "plugins.contributions",
] as const;

export const PluginSummary = z.object({
  name: z.string(),
  displayName: z.string(),
  description: z.string(),
  version: z.string().optional(),
  format: PluginFormat,
  enabled: z.boolean(),
  path: z.string(),
  source: z.string(),
  installedAt: z.string(),
  components: PluginComponents,
  config: z.array(PluginConfigOption),
  /** Which settings have a saved value. Values themselves never leave the runtime. */
  configured: z.array(z.string()),
  /** Why parts of the plugin do not reach agents, such as a missing setting or a name another server uses. */
  problems: z.array(z.string()),
});
export type PluginSummary = z.infer<typeof PluginSummary>;

export const PluginListResult = z.object({
  plugins: z.array(PluginSummary),
  pluginsPath: z.string(),
  problem: z.string().optional(),
});
export type PluginListResult = z.infer<typeof PluginListResult>;

export const PluginInstallCandidate = z.object({
  name: z.string(),
  displayName: z.string(),
  description: z.string(),
  version: z.string().optional(),
  format: PluginFormat,
  /** The folder in the source, "." for its root. */
  path: z.string(),
  components: PluginComponents,
  config: z.array(PluginConfigOption),
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  exists: z.boolean(),
  problem: z.string().optional(),
});
export type PluginInstallCandidate = z.infer<typeof PluginInstallCandidate>;

export const PluginInstallPreview = z.object({
  /** How the source reads to a person, for example owner/repo/path. */
  label: z.string(),
  marketplace: z.string().optional(),
  candidates: z.array(PluginInstallCandidate),
  /** Plugins the catalog lists from other places, which install from their own source. */
  elsewhere: z.array(z.object({ name: z.string(), description: z.string(), source: z.string() })),
});
export type PluginInstallPreview = z.infer<typeof PluginInstallPreview>;

export const PluginPrompt = z.object({
  plugin: z.string(),
  name: z.string(),
  description: z.string(),
  prompt: z.string(),
});
export type PluginPrompt = z.infer<typeof PluginPrompt>;

export const PluginAction = z.object({
  plugin: z.string(),
  name: z.string(),
  description: z.string(),
  /** The shell command with the plugin's folder and settings filled in. */
  command: z.string(),
});
export type PluginAction = z.infer<typeof PluginAction>;

export const PluginContributions = z.object({
  prompts: z.array(PluginPrompt),
  actions: z.array(PluginAction),
});
export type PluginContributions = z.infer<typeof PluginContributions>;
