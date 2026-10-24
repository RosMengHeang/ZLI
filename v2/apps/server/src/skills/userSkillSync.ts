import { rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { AGENT_SKILL_DIRS, type ListedProviderKind, ProviderKind, type SkillSyncOutcome } from "@zli-v2/contracts";

import { copySkillFolder, hashSkillFolder, pathKind, replaceFolder } from "./skillFolders.js";

/** The folder most agents share. Copying there once reaches all of them without duplicates. */
export const SHARED_SKILLS_DIR = ".agents/skills";

/** Skill folder paths ZLI copied, keyed by agent skills folder. */
export type SkillOwnership = Record<string, readonly string[]>;

export type SkillSyncOptions = {
  home: string;
  env?: NodeJS.ProcessEnv;
  isInstalled: (provider: ListedProviderKind) => Promise<boolean>;
  log?: (level: "info" | "warn", message: string, context: Record<string, unknown>) => void;
};

/** A home-relative folder from AGENT_SKILL_DIRS as an absolute path. */
export function userSkillsPath(dir: string, home: string, env: NodeJS.ProcessEnv = process.env): string {
  const kimiHome = env.KIMI_CODE_HOME?.trim();
  if (dir === ".kimi-code/skills" && kimiHome) return join(kimiHome, "skills");
  return join(home, ...dir.split("/"));
}

/**
 * The folders ZLI copies skills into: the shared `.agents/skills` for every agent that reads it, and the
 * agent's own folder for the rest (only Claude Code today).
 */
export function skillSyncTargets(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): Array<{ dir: string; path: string; agents: ListedProviderKind[] }> {
  const targets = new Map<string, ListedProviderKind[]>();
  for (const provider of ProviderKind.options) {
    const dirs = AGENT_SKILL_DIRS[provider].user;
    const dir = dirs.includes(SHARED_SKILLS_DIR) ? SHARED_SKILLS_DIR : dirs[0];
    if (!dir) continue;
    targets.set(dir, [...(targets.get(dir) ?? []), provider]);
  }
  return [...targets].map(([dir, agents]) => ({ dir, path: userSkillsPath(dir, home, env), agents }));
}

/**
 * Makes each agent skills folder hold a copy of every enabled skill. A folder is removed or replaced only
 * if ZLI created it, so a skill the person already had under the same name is reported as a conflict and
 * left alone. Returns what ZLI now owns per folder; persist it and pass it back on the next sync.
 */
export async function syncUserSkills(
  skills: ReadonlyArray<{ name: string; path: string }>,
  owned: SkillOwnership,
  options: SkillSyncOptions,
): Promise<{ outcomes: SkillSyncOutcome[]; owned: Record<string, string[]> }> {
  const wanted = new Map(skills.map((skill) => [skill.name, skill.path]));
  const hashes = new Map<string, Promise<string>>();
  const sourceHash = (name: string, path: string) => {
    let hash = hashes.get(name);
    if (!hash) {
      hash = hashSkillFolder(path);
      hashes.set(name, hash);
    }
    return hash;
  };
  const targets = skillSyncTargets(options.home, options.env);
  // Folders ZLI once wrote to but no longer targets still get their copies cleaned up.
  const stale = Object.keys(owned)
    .filter((path) => !targets.some((target) => target.path === path))
    .map((path) => ({ dir: "", path, agents: [] as ListedProviderKind[] }));
  const outcomes: SkillSyncOutcome[] = [];
  const nextOwned: Record<string, string[]> = {};

  for (const target of [...targets, ...stale]) {
    const previous = owned[target.path] ?? [];
    const conflicts: string[] = [];
    const keep: string[] = [];
    let changed = false;
    try {
      const isTarget = target.agents.length > 0;
      const active = isTarget && (await isActive(target.path, target.agents, options));
      for (const name of previous) {
        if (active && wanted.has(name)) continue;
        if (isTarget && !active && wanted.has(name)) {
          keep.push(name);
          continue;
        }
        if ((await pathKind(join(target.path, name))) !== "missing") {
          await rm(join(target.path, name), { recursive: true, force: true });
          changed = true;
        }
      }
      if (active) {
        for (const [name, source] of wanted) {
          const destination = join(target.path, name);
          const kind = await pathKind(destination);
          const ours = previous.includes(name);
          if (kind !== "missing" && !ours) {
            conflicts.push(name);
            continue;
          }
          const current = kind === "directory" ? await hashSkillFolder(destination).catch(() => "") : "";
          if (current !== (await sourceHash(name, source))) {
            await replaceFolder(destination, (temp) => copySkillFolder(source, temp));
            changed = true;
          }
          keep.push(name);
        }
      }
      if (keep.length > 0) nextOwned[target.path] = keep;
      outcomes.push({
        path: target.path,
        agents: target.agents,
        status: !isTarget
          ? changed
            ? "updated"
            : "unchanged"
          : !active
            ? "skipped-absent"
            : changed
              ? "updated"
              : "unchanged",
        conflicts,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Ownership is kept as it was so a later sync can still clean up.
      const names = [...new Set([...previous, ...keep])];
      if (names.length > 0) nextOwned[target.path] = names;
      outcomes.push({ path: target.path, agents: target.agents, status: "failed", conflicts, message });
      options.log?.("warn", "Skills were not copied to an agent folder.", { path: target.path, message });
    }
  }
  return {
    outcomes: outcomes.filter((outcome) => outcome.agents.length > 0 || outcome.status !== "unchanged"),
    owned: nextOwned,
  };
}

/** Copies go only to folders of installed agents, or folders that already exist, as with MCP settings. */
async function isActive(
  path: string,
  agents: readonly ListedProviderKind[],
  options: SkillSyncOptions,
): Promise<boolean> {
  for (const agent of agents) if (await options.isInstalled(agent).catch(() => false)) return true;
  return isDirectory(dirname(path));
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
