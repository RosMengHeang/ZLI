import { readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  AGENT_SKILL_DIRS,
  agentsReading,
  type FoundSkill,
  PROJECT_SKILLS_DIR,
  type ProjectId,
  ProviderKind,
  SKILL_FILE,
  type SkillDocument,
  SkillDraft,
  type SkillInstallPreview,
  type SkillListResult,
  type SkillSummary,
  type SkillSyncOutcome,
} from "@zli-v2/contracts";

import { isPlainObject, writeFileAtomic } from "../browser-tool/browserTool.js";
import {
  fetchGithubSkills,
  type GithubSkillSource,
  parseGithubSkillSource,
  type RemoteSkill,
  sourceKey,
} from "./githubSource.js";
import {
  isNotFound,
  listSkillFolders,
  pathKind,
  readSkillFolder,
  replaceFolder,
  SkillError,
  skillFileList,
  writeSkillFiles,
} from "./skillFolders.js";
import { formatSkillMarkdown, parseSkillMarkdown } from "./skillMarkdown.js";
import { type SkillOwnership, userSkillsPath } from "./userSkillSync.js";

/** Copies the enabled skills into agent folders; see syncUserSkills. */
export type UserSkillSync = (
  skills: ReadonlyArray<{ name: string; path: string }>,
  owned: SkillOwnership,
) => Promise<{ outcomes: SkillSyncOutcome[]; owned: Record<string, string[]> }>;

export type ProjectRef = { projectId: ProjectId; path: string };
export type ResolvedSkillScope = { kind: "user" } | { kind: "project"; project: ProjectRef };

type StoredFile = {
  version: 1;
  disabled: string[];
  sources: Record<string, string>;
  owned: Record<string, string[]>;
};

const PREVIEW_TTL_MS = 10 * 60 * 1000;
const MAX_CACHED_PREVIEWS = 3;

/**
 * The person's skills, kept as folders in ZLI's data folder and copied into each agent's user skills
 * folder. Project skills are read and written in the repository's `.agents/skills`, where most agents
 * read them directly; ZLI never copies them into worktrees.
 */
export class SkillStore {
  private disabled = new Set<string>();
  private sources: Record<string, string> = {};
  private owned: Record<string, string[]> = {};
  private outcomes: SkillSyncOutcome[] = [];
  private problem: string | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly previews = new Map<string, { at: number; skills: RemoteSkill[] }>();

  constructor(
    private readonly options: {
      libraryDir: string;
      statePath: string;
      home: string;
      env?: NodeJS.ProcessEnv;
      sync?: UserSkillSync;
      /** Skills from other sources, such as plugins. Library skills win a shared name. */
      extraSkills?: () => ReadonlyArray<{ name: string; path: string }>;
      fetch?: typeof fetch;
      githubToken?: string | undefined;
      now?: () => number;
    },
  ) {}

  async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.options.statePath, "utf8");
    } catch (error) {
      if (!isNotFound(error)) this.problem = "ZLI's skill settings could not be read.";
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.replace(/^\uFEFF/u, ""));
    } catch {
      this.problem = "ZLI's skill settings are not valid JSON.";
      return;
    }
    if (!isPlainObject(parsed)) {
      this.problem = "ZLI's skill settings are not valid.";
      return;
    }
    this.disabled = new Set(stringArray(parsed.disabled));
    this.sources = isPlainObject(parsed.sources)
      ? Object.fromEntries(
          Object.entries(parsed.sources).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        )
      : {};
    this.owned = isPlainObject(parsed.owned)
      ? Object.fromEntries(
          Object.entries(parsed.owned)
            .map(([path, names]) => [path, stringArray(names)] as const)
            .filter(([, names]) => names.length > 0),
        )
      : {};
  }

  libraryPath(): string {
    return this.options.libraryDir;
  }

  /** Names of every skill in the library, on or off. */
  async libraryNames(): Promise<string[]> {
    return (await listSkillFolders(this.options.libraryDir)).map((folder) => folder.name);
  }

  /** Agent skills folders where a skill the person already had kept this one from being copied. */
  conflictPaths(name: string): string[] {
    return this.outcomes.filter((outcome) => outcome.conflicts.includes(name)).map((outcome) => outcome.path);
  }

  async list(project?: ProjectRef): Promise<SkillListResult> {
    const conflictsFor = (name: string) =>
      this.outcomes.filter((outcome) => outcome.conflicts.includes(name)).map((outcome) => outcome.path);
    const user = (await listSkillFolders(this.options.libraryDir)).map((folder): SkillSummary => {
      const conflicts = conflictsFor(folder.name);
      const source = this.sources[folder.name];
      return {
        name: folder.name,
        description: folder.description,
        scope: "user",
        enabled: !this.disabled.has(folder.name),
        path: folder.path,
        ...(source ? { source } : {}),
        ...(folder.problem ? { problem: folder.problem } : {}),
        ...(conflicts.length > 0 ? { conflicts } : {}),
      };
    });
    const projectSkillsPath = project ? projectSkillsDir(project.path) : undefined;
    const shared = projectSkillsPath
      ? (await listSkillFolders(projectSkillsPath)).map(
          (folder): SkillSummary => ({
            name: folder.name,
            description: folder.description,
            scope: "project",
            enabled: true,
            path: folder.path,
            ...(folder.problem ? { problem: folder.problem } : {}),
          }),
        )
      : [];
    return {
      skills: [...user, ...shared],
      found: await this.found(project),
      libraryPath: this.options.libraryDir,
      sync: { enabled: this.options.sync !== undefined, outcomes: [...this.outcomes] },
      ...(project && projectSkillsPath
        ? { project: { projectId: project.projectId, path: project.path, skillsPath: projectSkillsPath } }
        : {}),
      ...(this.problem ? { problem: this.problem } : {}),
    };
  }

  async read(scope: ResolvedSkillScope, name: string): Promise<SkillDocument> {
    const path = join(this.root(scope), name);
    const folder = await readSkillFolder(path, name);
    if (!folder) throw new SkillError(`There is no skill named ${name}.`);
    const files = (await skillFileList(path)).filter((file) => file !== SKILL_FILE);
    return {
      name,
      description: folder.description,
      instructions: folder.parsed.body.replace(/\s+$/u, ""),
      scope: scope.kind,
      path,
      files,
    };
  }

  save(scope: ResolvedSkillScope, previousName: string | undefined, input: SkillDraft): Promise<void> {
    return this.serialize(async () => {
      const draft = SkillDraft.parse(input);
      const root = this.root(scope);
      const target = join(root, draft.name);
      const renaming = previousName !== undefined && previousName !== draft.name;
      if ((previousName === undefined || renaming) && (await pathKind(target)) !== "missing") {
        throw new SkillError(`A skill named ${draft.name} already exists.`);
      }
      if (renaming) {
        const from = join(root, previousName);
        if ((await pathKind(from)) === "missing") throw new SkillError(`There is no skill named ${previousName}.`);
        await rename(from, target);
        if (scope.kind === "user") this.renameState(previousName, draft.name);
      }
      let previous: ReturnType<typeof parseSkillMarkdown> | undefined;
      try {
        previous = parseSkillMarkdown(await readFile(join(target, SKILL_FILE), "utf8"));
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      await writeFileAtomic(join(target, SKILL_FILE), formatSkillMarkdown(draft, previous));
      if (scope.kind === "user") await this.afterUserChange();
    });
  }

  delete(scope: ResolvedSkillScope, name: string): Promise<void> {
    return this.serialize(async () => {
      const path = join(this.root(scope), name);
      if ((await pathKind(path)) === "missing") throw new SkillError(`There is no skill named ${name}.`);
      await rm(path, { recursive: true, force: true });
      if (scope.kind === "user") {
        this.disabled.delete(name);
        delete this.sources[name];
        await this.afterUserChange();
      }
    });
  }

  setEnabled(name: string, enabled: boolean): Promise<void> {
    return this.serialize(async () => {
      if ((await pathKind(join(this.options.libraryDir, name))) === "missing") {
        throw new SkillError(`There is no skill named ${name}.`);
      }
      if (enabled) this.disabled.delete(name);
      else this.disabled.add(name);
      await this.afterUserChange();
    });
  }

  async previewInstall(text: string, scope: ResolvedSkillScope = { kind: "user" }): Promise<SkillInstallPreview> {
    const source = parseSource(text);
    const skills = await this.remoteSkills(source);
    const root = this.root(scope);
    const candidates = await Promise.all(
      skills.map(async (skill) => ({
        name: skill.name,
        description: skill.description,
        path: skill.path,
        files: skill.files.length,
        bytes: skill.bytes,
        exists: (await pathKind(join(root, skill.name))) !== "missing",
        ...(skill.problem ? { problem: skill.problem } : {}),
      })),
    );
    return {
      owner: source.owner,
      repo: source.repo,
      ...(source.ref ? { ref: source.ref } : {}),
      path: source.path,
      candidates,
    };
  }

  install(text: string, scope: ResolvedSkillScope, names: readonly string[]): Promise<string[]> {
    return this.serialize(async () => {
      const source = parseSource(text);
      const skills = await this.remoteSkills(source);
      const chosen = names.map((name) => {
        const skill = skills.find((candidate) => candidate.name === name);
        if (!skill) throw new SkillError(`${name} is not in that folder.`);
        if (skill.problem) throw new SkillError(`${name}: ${skill.problem}`);
        return skill;
      });
      const root = this.root(scope);
      for (const skill of chosen) {
        await replaceFolder(join(root, skill.name), (temp) => writeSkillFiles(temp, skill.files));
        if (scope.kind === "user") {
          this.sources[skill.name] = sourceUrl(source, skill.path);
          this.disabled.delete(skill.name);
        }
      }
      if (scope.kind === "user") await this.afterUserChange();
      return chosen.map((skill) => skill.name);
    });
  }

  /** Brings agent folders in line with the library, for example after an agent CLI was installed. */
  syncUserSettings(): Promise<void> {
    return this.serialize(() => this.sync());
  }

  async waitForIdle(): Promise<void> {
    await this.queue.catch(() => undefined);
  }

  private root(scope: ResolvedSkillScope): string {
    return scope.kind === "user" ? this.options.libraryDir : projectSkillsDir(scope.project.path);
  }

  private async found(project: ProjectRef | undefined): Promise<FoundSkill[]> {
    const home = this.options.home;
    const env = this.options.env ?? process.env;
    const userDirs = unique(ProviderKind.options.flatMap((provider) => AGENT_SKILL_DIRS[provider].user));
    const projectDirs = unique(ProviderKind.options.flatMap((provider) => AGENT_SKILL_DIRS[provider].project)).filter(
      (dir) => dir !== PROJECT_SKILLS_DIR,
    );
    const scans = [
      ...userDirs.map((dir) => ({ scope: "user" as const, dir, path: userSkillsPath(dir, home, env) })),
      ...(project
        ? projectDirs.map((dir) => ({ scope: "project" as const, dir, path: join(project.path, ...dir.split("/")) }))
        : []),
    ];
    const results = await Promise.all(
      scans.map(async (scan) => {
        const ours = new Set(this.owned[scan.path] ?? []);
        const agents = agentsReading(scan.scope, scan.dir);
        return (await listSkillFolders(scan.path))
          .filter((folder) => !ours.has(folder.name))
          .map(
            (folder): FoundSkill => ({
              name: folder.name,
              description: folder.description,
              scope: scan.scope,
              path: folder.path,
              dir: scan.dir,
              agents,
              ...(folder.problem ? { problem: folder.problem } : {}),
            }),
          );
      }),
    );
    return results.flat();
  }

  private async remoteSkills(source: GithubSkillSource): Promise<RemoteSkill[]> {
    const now = (this.options.now ?? Date.now)();
    const key = sourceKey(source);
    for (const [entry, value] of this.previews) if (now - value.at > PREVIEW_TTL_MS) this.previews.delete(entry);
    const cached = this.previews.get(key);
    if (cached) return cached.skills;
    const skills = await fetchGithubSkills(source, {
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      token: this.options.githubToken,
    });
    if (skills.length === 0) throw new SkillError("No folder with a SKILL.md was found there.");
    this.previews.set(key, { at: now, skills });
    while (this.previews.size > MAX_CACHED_PREVIEWS) {
      const oldest = this.previews.keys().next().value;
      if (oldest === undefined) break;
      this.previews.delete(oldest);
    }
    return skills;
  }

  private renameState(from: string, to: string): void {
    if (this.disabled.delete(from)) this.disabled.add(to);
    const source = this.sources[from];
    delete this.sources[from];
    if (source) this.sources[to] = source;
  }

  private async afterUserChange(): Promise<void> {
    await this.write();
    this.problem = undefined;
    await this.sync();
  }

  private async sync(): Promise<void> {
    const sync = this.options.sync;
    if (!sync) return;
    const library = await listSkillFolders(this.options.libraryDir);
    const names = new Set(library.map((folder) => folder.name));
    const enabled = library
      .filter((folder) => !folder.problem && !this.disabled.has(folder.name))
      .map((folder) => ({ name: folder.name, path: folder.path }));
    const extra = (this.options.extraSkills?.() ?? []).filter((skill) => !names.has(skill.name));
    let result: Awaited<ReturnType<UserSkillSync>>;
    try {
      result = await sync([...enabled, ...extra], this.owned);
    } catch {
      return;
    }
    this.outcomes = result.outcomes;
    if (JSON.stringify(result.owned) !== JSON.stringify(this.owned)) {
      this.owned = result.owned;
      // The skills themselves are saved; a lost ownership record only means a later delete leaves a copy.
      await this.write().catch(() => undefined);
    }
  }

  private async write(): Promise<void> {
    const file: StoredFile = {
      version: 1,
      disabled: [...this.disabled].sort(),
      sources: this.sources,
      owned: this.owned,
    };
    await writeFileAtomic(this.options.statePath, `${JSON.stringify(file, null, 2)}\n`);
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.catch(() => undefined).then(work);
    this.queue = run;
    return run;
  }
}

export function projectSkillsDir(projectPath: string): string {
  return join(projectPath, ...PROJECT_SKILLS_DIR.split("/"));
}

function parseSource(text: string): GithubSkillSource {
  const source = parseGithubSkillSource(text);
  if ("problem" in source) throw new SkillError(source.problem);
  return source;
}

function sourceUrl(source: GithubSkillSource, path: string): string {
  const folder = path === "." ? "" : `/${path}`;
  return `https://github.com/${source.owner}/${source.repo}${source.ref || folder ? `/tree/${source.ref ?? "HEAD"}${folder}` : ""}`;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
