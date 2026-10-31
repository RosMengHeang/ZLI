import { rm } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { AGENT_SKILL_DIRS, type ListedProviderKind, ProviderKind, type SkillSyncOutcome } from "@zli-v2/contracts";

import { GitProcess } from "../git/GitProcess.js";
import { isConfined } from "../worktrees/confinedPath.js";
import { copySkillFolder, hashSkillFolder, pathKind, replaceFolder } from "./skillFolders.js";

/** The folder most agents share. Copying there once reaches all of them without duplicates. */
export const SHARED_SKILLS_DIR = ".agents/skills";

/**
 * The skill folders ZLI copied, keyed by the skills folder they are in, with a digest of each copy as ZLI
 * left it. An empty digest comes from an older version that kept only names.
 */
export type SkillOwnership = Record<string, Readonly<Record<string, string>>>;

export type SkillCopyTarget = {
  path: string;
  agents: ListedProviderKind[];
  /** The folder `path` is inside, such as the worktree. No folder between the two may be a link. */
  root?: string;
  /** Runs before ZLI copies the named skills into the folder. */
  prepare?: (names: readonly string[]) => Promise<void>;
};

export type SkillCopyOptions = {
  log?: (level: "info" | "warn", message: string, context: Record<string, unknown>) => void;
  /** The `root` of a skills folder that is no longer a target. */
  rootOf?: (path: string) => string | undefined;
  git?: GitProcess;
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

/** The worktree a skills folder from worktreeSkillDirs is in, or undefined for any other folder. */
export function worktreeRootOf(path: string): string | undefined {
  for (const { dir } of worktreeSkillDirs()) {
    const suffix = `${sep}${dir.split("/").join(sep)}`;
    if (path.endsWith(suffix) && path.length > suffix.length) return path.slice(0, -suffix.length);
  }
  return undefined;
}

/**
 * Makes each target folder hold a copy of every skill in `skills`. ZLI replaces or removes a folder only
 * while it is still exactly the copy ZLI made and git does not track it. A folder that changed, became
 * tracked (for example after a branch switch), or sits behind a link is the person's or the repository's:
 * ZLI stops owning it and reports it as a conflict when the skill is still wanted. Copies in folders that
 * are no longer targets are removed. Returns what ZLI now owns per folder; persist it and pass it back on
 * the next sync. Outcomes list only folders with a conflict or a failure.
 */
export async function syncSkillCopies(
  skills: ReadonlyArray<{ name: string; path: string }>,
  owned: SkillOwnership,
  targets: readonly SkillCopyTarget[],
  options: SkillCopyOptions = {},
): Promise<{ outcomes: SkillSyncOutcome[]; owned: Record<string, Record<string, string>> }> {
  const git = options.git ?? new GitProcess();
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
    .map((path): SkillCopyTarget & { stale: true } => {
      const root = options.rootOf?.(path);
      return { path, agents: [], ...(root ? { root } : {}), stale: true };
    });
  const outcomes: SkillSyncOutcome[] = [];
  const nextOwned: Record<string, Record<string, string>> = {};

  for (const target of [...targets, ...stale]) {
    const previous = owned[target.path] ?? {};
    const isStale = "stale" in target;
    const conflicts: string[] = [];
    const current: Record<string, string> = { ...previous };
    const relinquish = (name: string, why: string) => {
      delete current[name];
      options.log?.("info", why, { path: join(target.path, name) });
    };
    try {
      if (target.root !== undefined && !(await isConfined(target.root, relativeDir(target.root, target.path)))) {
        // Nothing behind the link is ZLI's to change, including copies recorded there before.
        options.log?.("info", "Left a skills folder alone because it or a folder above it is a link.", {
          path: target.path,
        });
        if (!isStale && wanted.size > 0) {
          outcomes.push({
            path: target.path,
            agents: target.agents,
            status: "failed",
            conflicts: [],
            message: "it or a folder above it is a link, so ZLI left it alone",
          });
        }
        continue;
      }
      const tracked = Object.keys(previous).length > 0 ? await trackedNames(git, target.path) : new Set<string>();
      const stillOurs = async (name: string): Promise<boolean> => {
        if (tracked.has(name)) return false;
        const kind = await pathKind(join(target.path, name));
        if (kind === "missing") return true;
        if (kind !== "directory") return false;
        const recorded = previous[name] ?? "";
        return recorded === "" || (await hashSkillFolder(join(target.path, name)).catch(() => "")) === recorded;
      };
      for (const name of Object.keys(previous)) {
        if (!isStale && wanted.has(name)) continue;
        const destination = join(target.path, name);
        if ((await pathKind(destination)) === "missing") {
          delete current[name];
        } else if (await stillOurs(name)) {
          await rm(destination, { recursive: true, force: true });
          delete current[name];
        } else {
          relinquish(name, "Left a skill folder alone because it changed or git tracks it since ZLI copied it.");
        }
      }
      if (!isStale) {
        const place: Array<[string, string]> = [];
        for (const [name, source] of wanted) {
          const exists = (await pathKind(join(target.path, name))) !== "missing";
          if (name in previous && !(await stillOurs(name))) {
            relinquish(name, "Left a skill folder alone because it changed or git tracks it since ZLI copied it.");
            conflicts.push(name);
          } else if (!(name in previous) && exists) {
            conflicts.push(name);
          } else {
            place.push([name, source]);
          }
        }
        if (place.length > 0) await target.prepare?.(place.map(([name]) => name));
        for (const [name, source] of place) {
          const destination = join(target.path, name);
          const kind = await pathKind(destination);
          const copy = kind === "directory" ? await hashSkillFolder(destination).catch(() => "") : "";
          const hash = await sourceHash(name, source);
          // Owned before the copy, so a failure part way still leaves a record to clean up.
          if (!(name in current)) current[name] = hash;
          if (copy !== hash) await replaceFolder(destination, (temp) => copySkillFolder(source, temp));
          current[name] = hash;
        }
      }
      if (Object.keys(current).length > 0) nextOwned[target.path] = current;
      if (conflicts.length > 0) {
        outcomes.push({ path: target.path, agents: target.agents, status: "unchanged", conflicts });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (Object.keys(current).length > 0) nextOwned[target.path] = current;
      outcomes.push({ path: target.path, agents: target.agents, status: "failed", conflicts, message });
      options.log?.("warn", "Skills were not copied to an agent folder.", { path: target.path, message });
    }
  }
  return { outcomes, owned: nextOwned };
}

function relativeDir(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

/**
 * Skill folders inside `dir` that hold files git tracks. A folder outside any repository has none. Any
 * other git failure throws, so nothing is removed on a guess.
 */
async function trackedNames(git: GitProcess, dir: string): Promise<Set<string>> {
  if ((await pathKind(dir)) !== "directory") return new Set();
  let stdout: string;
  try {
    ({ stdout } = await git.run(["ls-files", "-z", "--", "."], { cwd: dir, timeoutMs: 10_000 }));
  } catch (error) {
    if (outsideRepository(error)) return new Set();
    throw error;
  }
  return new Set(
    stdout
      .split("\0")
      .map((file) => file.split("/")[0] ?? "")
      .filter((name) => name.length > 0),
  );
}

function outsideRepository(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("code" in error && error.code === "ENOENT") return true;
  return "stderr" in error && typeof error.stderr === "string" && /not a git repository/iu.test(error.stderr);
}
