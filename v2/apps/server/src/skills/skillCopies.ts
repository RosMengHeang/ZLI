import { rm } from "node:fs/promises";
import { join } from "node:path";

import { AGENT_SKILL_DIRS, type ListedProviderKind, ProviderKind, type SkillSyncOutcome } from "@zli-v2/contracts";

import { copySkillFolder, hashSkillFolder, pathKind, replaceFolder } from "./skillFolders.js";

/** The folder most agents share. Copying there once reaches all of them without duplicates. */
export const SHARED_SKILLS_DIR = ".agents/skills";

/** Skill folder names ZLI copied, keyed by the skills folder they are in. */
export type SkillOwnership = Record<string, readonly string[]>;

export type SkillCopyTarget = {
  path: string;
  agents: ListedProviderKind[];
  /** Runs before ZLI copies the named skills into the folder. */
  prepare?: (names: readonly string[]) => Promise<void>;
};

/** A home-relative folder from AGENT_SKILL_DIRS as an absolute path. */
export function userSkillsPath(dir: string, home: string, env: NodeJS.ProcessEnv = process.env): string {
  const kimiHome = env.KIMI_CODE_HOME?.trim();
  if (dir === ".kimi-code/skills" && kimiHome) return join(kimiHome, "skills");
  return join(home, ...dir.split("/"));
}

/**
 * The project folders ZLI copies skills into, relative to a worktree: the shared `.agents/skills` for
 * every agent that reads it, and the agent's own folder for the rest (only Claude Code today).
 */
export function worktreeSkillDirs(): Array<{ dir: string; agents: ListedProviderKind[] }> {
  const targets = new Map<string, ListedProviderKind[]>();
  for (const provider of ProviderKind.options) {
    const dirs = AGENT_SKILL_DIRS[provider].project;
    const dir = dirs.includes(SHARED_SKILLS_DIR) ? SHARED_SKILLS_DIR : dirs[0];
    if (!dir) continue;
    targets.set(dir, [...(targets.get(dir) ?? []), provider]);
  }
  return [...targets].map(([dir, agents]) => ({ dir, agents }));
}

/**
 * Makes each target folder hold a copy of every skill in `skills`. A folder is removed or replaced only
 * if ZLI created it, so a skill already there under the same name is reported as a conflict and left
 * alone. Copies in folders that are no longer targets are removed. Returns what ZLI now owns per folder;
 * persist it and pass it back on the next sync. Outcomes list only folders with a conflict or a failure.
 */
export async function syncSkillCopies(
  skills: ReadonlyArray<{ name: string; path: string }>,
  owned: SkillOwnership,
  targets: readonly SkillCopyTarget[],
  options: { log?: (level: "info" | "warn", message: string, context: Record<string, unknown>) => void } = {},
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
  const stale = Object.keys(owned)
    .filter((path) => !targets.some((target) => target.path === path))
    .map((path): SkillCopyTarget & { stale: true } => ({ path, agents: [], stale: true }));
  const outcomes: SkillSyncOutcome[] = [];
  const nextOwned: Record<string, string[]> = {};

  for (const target of [...targets, ...stale]) {
    const previous = owned[target.path] ?? [];
    const isStale = "stale" in target;
    const conflicts: string[] = [];
    const keep: string[] = [];
    try {
      for (const name of previous) {
        if (!isStale && wanted.has(name)) continue;
        if ((await pathKind(join(target.path, name))) !== "missing") {
          await rm(join(target.path, name), { recursive: true, force: true });
        }
      }
      if (!isStale) {
        const place: Array<[string, string]> = [];
        for (const [name, source] of wanted) {
          const ours = previous.includes(name);
          if (!ours && (await pathKind(join(target.path, name))) !== "missing") conflicts.push(name);
          else place.push([name, source]);
        }
        if (place.length > 0) await target.prepare?.(place.map(([name]) => name));
        for (const [name, source] of place) {
          const destination = join(target.path, name);
          const kind = await pathKind(destination);
          const current = kind === "directory" ? await hashSkillFolder(destination).catch(() => "") : "";
          // Owned before the copy, so a failure part way still leaves a record to clean up.
          keep.push(name);
          if (current !== (await sourceHash(name, source))) {
            await replaceFolder(destination, (temp) => copySkillFolder(source, temp));
          }
        }
      }
      if (keep.length > 0) nextOwned[target.path] = keep;
      if (conflicts.length > 0) {
        outcomes.push({ path: target.path, agents: target.agents, status: "unchanged", conflicts });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const names = [...new Set([...previous, ...keep])];
      if (names.length > 0) nextOwned[target.path] = names;
      outcomes.push({ path: target.path, agents: target.agents, status: "failed", conflicts, message });
      options.log?.("warn", "Skills were not copied to an agent folder.", { path: target.path, message });
    }
  }
  return { outcomes, owned: nextOwned };
}
