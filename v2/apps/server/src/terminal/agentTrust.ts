import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ListedProviderKind } from "@zli-v2/contracts";

import { isPlainObject, writeFileAtomic } from "../browser-tool/browserTool.js";
import type { Engine } from "../orchestration/Engine.js";

export type AgentFolderTrustOptions = {
  /** The project folder the person trusted in ZLI. */
  projectPath: string;
  /** Where the agent starts: the project folder or one of its worktrees. */
  cwd: string;
  /** The agent's environment, which can move its config directory to an account's own. */
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  now?: () => Date;
};

export type AgentFolderTrustLaunch = { args: string[]; env: Record<string, string> };

/** The project folder of a worktree, when the person let agents work in that project. */
export async function trustedProject(
  engine: Pick<Engine, "projection">,
  worktreeId: string | undefined,
): Promise<string | undefined> {
  if (!worktreeId) return undefined;
  const projection = await engine.projection();
  const projectId = projection.worktrees.find((worktree) => worktree.worktreeId === worktreeId)?.projectId;
  const project = projection.projects.find((entry) => entry.projectId === projectId);
  return project?.agentsTrusted === true ? project.path : undefined;
}

/**
 * Answers an agent CLI's own "trust this folder?" question for a project the person trusted in ZLI.
 * Gemini and Kimi take a flag or variable for one launch. Claude Code, Codex, Copilot, and Droid read
 * trust only from their own settings, so the folder is added there. Trust is not permission: the
 * permission mode still decides what the agent may do without asking. When a settings file cannot be
 * read or written, the CLI asks on its own as before.
 */
export async function agentFolderTrust(
  provider: ListedProviderKind,
  options: AgentFolderTrustOptions,
): Promise<AgentFolderTrustLaunch> {
  const none = { args: [], env: {} };
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  try {
    switch (provider) {
      case "gemini":
        return { args: ["--skip-trust"], env: {} };
      case "kimi":
        return { args: [], env: { KIMI_CODE_TRUST_WORKSPACE: "1" } };
      case "claude-code": {
        // Claude Code also trusts a worktree whose main checkout is trusted.
        const folders = await variants(options.projectPath, options.platform ?? process.platform);
        await updateJson(join(dirFromEnv(env.CLAUDE_CONFIG_DIR) ?? home, ".claude.json"), (root) =>
          trustClaude(root, folders),
        );
        return none;
      }
      case "codex": {
        // Codex also trusts a worktree whose main checkout is trusted.
        const folders = await variants(options.projectPath);
        await trustCodex(join(dirFromEnv(env.CODEX_HOME) ?? join(home, ".codex"), "config.toml"), folders);
        return none;
      }
      case "copilot": {
        const folders = await variants(options.projectPath);
        await updateJson(join(dirFromEnv(env.COPILOT_HOME) ?? join(home, ".copilot"), "config.json"), (root) =>
          trustCopilot(root, folders),
        );
        return none;
      }
      case "droid": {
        // Droid keys trust by the repository root, and a worktree is its own root.
        const folders = await variants(options.cwd);
        const trustedAt = (options.now?.() ?? new Date()).toISOString();
        await updateJson(join(home, ".factory", "settings.json"), (root) => trustDroid(root, folders, trustedAt));
        return none;
      }
      default:
        return none;
    }
  } catch {
    return none;
  }
}

function trustClaude(root: Record<string, unknown>, folders: readonly string[]): boolean {
  const projects = root.projects ?? {};
  if (!isPlainObject(projects)) return false;
  let changed = false;
  for (const folder of folders) {
    const entry = projects[folder];
    if (isPlainObject(entry) && entry.hasTrustDialogAccepted === true) continue;
    projects[folder] = { ...(isPlainObject(entry) ? entry : {}), hasTrustDialogAccepted: true };
    changed = true;
  }
  if (changed) root.projects = projects;
  return changed;
}

function trustCopilot(root: Record<string, unknown>, folders: readonly string[]): boolean {
  const trusted = root.trustedFolders ?? [];
  if (!Array.isArray(trusted)) return false;
  const missing = folders.filter((folder) => !trusted.includes(folder));
  if (missing.length === 0) return false;
  root.trustedFolders = [...trusted, ...missing];
  return true;
}

function trustDroid(root: Record<string, unknown>, folders: readonly string[], trustedAt: string): boolean {
  const general = root.general ?? {};
  if (!isPlainObject(general)) return false;
  const trusted = general.trustedFolders ?? {};
  if (!isPlainObject(trusted)) return false;
  const missing = folders.filter((folder) => !(folder in trusted));
  if (missing.length === 0) return false;
  for (const folder of missing) trusted[folder] = { trustedAt };
  root.general = { ...general, trustedFolders: trusted };
  return true;
}

/**
 * Appends a `[projects."<folder>"]` table. Codex splits `-c` keys on dots, so a per-launch override
 * cannot name a path such as `my.app`. A folder Codex already lists, trusted or not, is left as it is.
 */
async function trustCodex(path: string, folders: readonly string[]): Promise<void> {
  const text = (await readOptional(path)) ?? "";
  const missing = folders.filter((folder) => !codexListsProject(text, folder));
  if (missing.length === 0) return;
  const tables = missing.map((folder) => `[projects.${tomlString(folder)}]\ntrust_level = "trusted"\n`).join("\n");
  const separator = text.length === 0 ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  await writeFileAtomic(path, `${text}${separator}${tables}`);
}

function codexListsProject(text: string, folder: string): boolean {
  const literal = folder.includes("'") ? undefined : `'${folder}'`;
  return text.split(/\r?\n/u).some((line) => {
    const header = line.trim();
    if (!header.startsWith("[projects.") || !header.endsWith("]")) return false;
    const key = header.slice("[projects.".length, -1).trim();
    return key === tomlString(folder) || key === literal;
  });
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}

/** Reads a JSON object, lets `change` edit it, and writes it back only when something changed. */
async function updateJson(path: string, change: (root: Record<string, unknown>) => boolean): Promise<void> {
  const text = await readOptional(path);
  // Copilot opens its config.json with `//` comment lines; they are kept as they are.
  const lines = (text ?? "").replace(/^\uFEFF/u, "").split(/(?<=\n)/u);
  const headerLength = lines.findIndex((line) => !/^\s*\/\//u.test(line));
  const header = lines.slice(0, headerLength < 0 ? lines.length : headerLength).join("");
  const body = lines.slice(header.length === 0 ? 0 : headerLength).join("");
  const parsed: unknown = body.trim().length > 0 ? JSON.parse(body) : {};
  if (!isPlainObject(parsed)) return;
  if (!change(parsed)) return;
  await writeFileAtomic(path, `${header}${JSON.stringify(parsed, null, indentOf(body))}\n`);
}

/** The folder as ZLI knows it and as the operating system resolves it, since CLIs key trust by either. */
async function variants(folder: string, platform?: NodeJS.Platform): Promise<string[]> {
  const resolved = await realpath(folder).catch(() => folder);
  const all = [folder, resolved];
  // Claude Code writes Windows paths with forward slashes.
  if (platform === "win32") all.push(...all.map((path) => path.replace(/\\/gu, "/")));
  return [...new Set(all)];
}

function dirFromEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function indentOf(text: string): string | number {
  const match = text.match(/^[{[][^\S\r\n]*\r?\n([ \t]+)\S/u);
  return match?.[1] ?? 2;
}
