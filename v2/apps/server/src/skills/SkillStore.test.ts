import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { ProjectId } from "@zli-v2/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { runSkillCommand } from "./runSkillCommand.js";
import { SkillStore } from "./SkillStore.js";
import { type SkillOwnership, syncSkillCopies, worktreeRootOf, worktreeSkillDirs } from "./skillCopies.js";
import { fakeFetch, githubTarball } from "./testTarball.js";

const execFileAsync = promisify(execFile);
const temps: string[] = [];
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function setup(fetchImpl?: typeof fetch) {
  const root = await mkdtemp(join(tmpdir(), "zli-skills-"));
  temps.push(root);
  const home = join(root, "home");
  const data = join(root, "data");
  const project = join(root, "repo");
  const worktree = join(root, "repo-worktrees", "feature");
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
  await mkdir(worktree, { recursive: true });
  const worktrees = [worktree];
  const prepared: string[] = [];
  const options = {
    libraryDir: join(data, "skills"),
    statePath: join(data, "skills.json"),
    home,
    env: {},
    sync: (skills: ReadonlyArray<{ name: string; path: string }>, owned: SkillOwnership) =>
      syncSkillCopies(
        skills,
        owned,
        worktrees.flatMap((folder) =>
          worktreeSkillDirs().map(({ dir, agents }) => ({
            path: join(folder, ...dir.split("/")),
            agents,
            root: folder,
            prepare: async (names: readonly string[]) => {
              prepared.push(...names.map((name) => `${dir}/${name}`));
            },
          })),
        ),
        { rootOf: worktreeRootOf },
      ),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  };
  const store = new SkillStore(options);
  await store.load();
  return { root, home, data, project, worktree, worktrees, prepared, options, store };
}

const review = { name: "review", description: "Review a diff for bugs.", instructions: "# Review\n\nRead the diff." };
const reviewFile = "---\nname: review\ndescription: Review a diff for bugs.\n---\n\n# Review\n\nRead the diff.\n";

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd })).stdout;
}

/** Makes the worktree a repository with one commit on main. */
async function initRepository(worktree: string): Promise<void> {
  await git(worktree, "init", "-b", "main");
  await git(worktree, "config", "user.email", "zli-tests@example.invalid");
  await git(worktree, "config", "user.name", "ZLI Tests");
  await writeFile(join(worktree, "README.md"), "initial\n");
  await git(worktree, "add", "README.md");
  await git(worktree, "commit", "-m", "initial");
}
const projectRef = (path: string) => ({ projectId: "11111111-1111-4111-8111-111111111111" as ProjectId, path });

describe("skill copy targets", () => {
  it("copies once into the shared project folder and into Claude Code's own folder", () => {
    const dirs = worktreeSkillDirs();
    expect(dirs.map((target) => target.dir)).toEqual([".agents/skills", ".claude/skills"]);
    expect(dirs[0]?.agents).toEqual([
      "codex",
      "cursor-agent",
      "droid",
      "opencode",
      "gemini",
      "copilot",
      "kimi",
      "qwen",
      "goose",
    ]);
    expect(dirs[1]?.agents).toEqual(["claude-code"]);
  });
});

describe("SkillStore", () => {
  it("saves a user skill and copies it into each worktree, never into the home folder", async () => {
    const { home, data, worktree, prepared, store } = await setup();
    await store.save({ kind: "user" }, undefined, review);
    const text = await readFile(join(data, "skills", "review", "SKILL.md"), "utf8");
    expect(text).toBe("---\nname: review\ndescription: Review a diff for bugs.\n---\n\n# Review\n\nRead the diff.\n");
    expect(await readFile(join(worktree, ".claude", "skills", "review", "SKILL.md"), "utf8")).toBe(text);
    expect(await readFile(join(worktree, ".agents", "skills", "review", "SKILL.md"), "utf8")).toBe(text);
    expect(await readdir(home)).toEqual([]);
    expect(prepared).toEqual([".agents/skills/review", ".claude/skills/review"]);

    const listed = await store.list(projectRef(worktree));
    expect(listed.skills).toEqual([
      {
        name: "review",
        description: "Review a diff for bugs.",
        scope: "user",
        enabled: true,
        path: join(data, "skills", "review"),
      },
    ]);
    // ZLI's own copies are neither project skills nor skills found in agent folders.
    expect(listed.found).toEqual([]);
    expect(listed.sync).toEqual({ enabled: true, outcomes: [] });
    expect(await store.read({ kind: "user" }, "review")).toMatchObject({
      instructions: "# Review\n\nRead the diff.",
      files: [],
    });

    await expect(store.save({ kind: "user" }, undefined, review)).rejects.toThrow(
      "A skill named review already exists.",
    );
  });

  it("never overwrites a skill already in the worktree and lists it as found", async () => {
    const { worktree, store } = await setup();
    const theirs = join(worktree, ".claude", "skills", "review");
    await mkdir(theirs, { recursive: true });
    await writeFile(join(theirs, "SKILL.md"), "---\nname: review\ndescription: Mine.\n---\nMine\n");
    await store.save({ kind: "user" }, undefined, review);
    expect(await readFile(join(theirs, "SKILL.md"), "utf8")).toContain("Mine.");
    expect(await readFile(join(worktree, ".agents", "skills", "review", "SKILL.md"), "utf8")).toContain(
      "Review a diff",
    );
    const listed = await store.list(projectRef(worktree));
    expect(listed.skills[0]?.conflicts).toEqual([join(worktree, ".claude", "skills")]);
    expect(listed.sync.outcomes).toEqual([
      {
        path: join(worktree, ".claude", "skills"),
        agents: ["claude-code"],
        status: "unchanged",
        conflicts: ["review"],
      },
    ]);
    expect(listed.found).toEqual([
      expect.objectContaining({ name: "review", description: "Mine.", scope: "project", dir: ".claude/skills" }),
    ]);

    await store.delete({ kind: "user" }, "review");
    expect(await readFile(join(theirs, "SKILL.md"), "utf8")).toContain("Mine.");
    expect(await readdir(join(worktree, ".agents", "skills"))).toEqual([]);
  });

  it("removes only its own copies when a skill is turned off, renamed, or deleted", async () => {
    const { worktree, options, store } = await setup();
    const claude = join(worktree, ".claude", "skills");
    await store.save({ kind: "user" }, undefined, review);
    await store.setEnabled("review", false);
    expect(await readdir(claude)).toEqual([]);
    await store.setEnabled("review", true);
    expect(await readdir(claude)).toEqual(["review"]);

    await store.save({ kind: "user" }, "review", { ...review, name: "code-review", description: "Updated." });
    expect(await readdir(claude)).toEqual(["code-review"]);
    expect(await readFile(join(claude, "code-review", "SKILL.md"), "utf8")).toContain("description: Updated.");

    const reloaded = new SkillStore(options);
    await reloaded.load();
    await reloaded.delete({ kind: "user" }, "code-review");
    expect(await readdir(claude)).toEqual([]);
    expect((await reloaded.list()).skills).toEqual([]);
  });

  it("follows worktrees as they come and go, and removes every copy when asked", async () => {
    const { root, worktree, worktrees, options, store } = await setup();
    await store.save({ kind: "user" }, undefined, review);
    const second = join(root, "repo-worktrees", "other");
    await mkdir(second, { recursive: true });
    worktrees.push(second);
    await store.syncCopies();
    expect(await readdir(join(second, ".agents", "skills"))).toEqual(["review"]);

    // A worktree ZLI no longer lists loses its copies on the next sync.
    worktrees.shift();
    await store.syncCopies();
    expect(await readdir(join(worktree, ".agents", "skills"))).toEqual([]);
    expect(await readdir(join(second, ".claude", "skills"))).toEqual(["review"]);

    const restarted = new SkillStore(options);
    await restarted.load();
    await restarted.removeCopies();
    expect(await readdir(join(second, ".agents", "skills"))).toEqual([]);
    expect(await readdir(join(second, ".claude", "skills"))).toEqual([]);
    expect(JSON.parse(await readFile(options.statePath, "utf8")).copies).toEqual({});
    // The library itself stays.
    expect((await restarted.list()).skills.map((skill) => skill.name)).toEqual(["review"]);
  });

  it("removes the copies older versions made in the home folder, and nothing else there", async () => {
    const { home, data, options } = await setup();
    const agents = join(home, ".agents", "skills");
    await mkdir(join(agents, "review"), { recursive: true });
    await mkdir(join(agents, "mine"), { recursive: true });
    await mkdir(data, { recursive: true });
    await writeFile(
      options.statePath,
      JSON.stringify({ version: 1, disabled: [], sources: {}, owned: { [agents]: ["review"] } }),
    );
    const store = new SkillStore(options);
    await store.load();
    await store.cleanUpUserFolders(async (owned) => (await syncSkillCopies([], owned, [])).owned);
    expect(await readdir(agents)).toEqual(["mine"]);
    expect(JSON.parse(await readFile(options.statePath, "utf8")).owned).toEqual({});
  });

  it("stops owning a copy the person edited, and neither updates nor removes it", async () => {
    const { worktree, store } = await setup();
    const shared = join(worktree, ".agents", "skills", "review", "SKILL.md");
    const claude = join(worktree, ".claude", "skills", "review", "SKILL.md");
    await store.save({ kind: "user" }, undefined, review);
    await writeFile(shared, "---\nname: review\ndescription: My edit.\n---\n");

    await store.save({ kind: "user" }, "review", { ...review, description: "Updated." });
    expect(await readFile(shared, "utf8")).toContain("My edit.");
    expect(await readFile(claude, "utf8")).toContain("Updated.");
    expect((await store.list()).sync.outcomes).toEqual([
      {
        path: join(worktree, ".agents", "skills"),
        agents: expect.any(Array),
        status: "unchanged",
        conflicts: ["review"],
      },
    ]);

    await store.removeCopies();
    expect(await readFile(shared, "utf8")).toContain("My edit.");
    expect(await readdir(join(worktree, ".claude", "skills"))).toEqual([]);
  });

  it("leaves the repository's version alone after a branch switch replaces ZLI's copy", async () => {
    const { worktree, store } = await setup();
    await initRepository(worktree);
    await git(worktree, "checkout", "-b", "with-skill");
    await mkdir(join(worktree, ".agents", "skills", "review"), { recursive: true });
    const theirs = "---\nname: review\ndescription: The team's review.\n---\n";
    await writeFile(join(worktree, ".agents", "skills", "review", "SKILL.md"), theirs);
    await git(worktree, "add", ".agents");
    await git(worktree, "commit", "-m", "add review skill");
    await git(worktree, "checkout", "main");
    // Hidden the way ZLI hides its copies; git then replaces an ignored copy on checkout.
    await writeFile(join(worktree, ".git", "info", "exclude"), "/.agents/skills/review/\n/.claude/\n");
    await store.save({ kind: "user" }, undefined, review);
    expect(await readFile(join(worktree, ".agents", "skills", "review", "SKILL.md"), "utf8")).toBe(reviewFile);

    await git(worktree, "checkout", "with-skill");
    await store.save({ kind: "user" }, "review", { ...review, description: "Updated." });
    expect(await readFile(join(worktree, ".agents", "skills", "review", "SKILL.md"), "utf8")).toBe(theirs);
    await store.removeCopies();
    expect(await readFile(join(worktree, ".agents", "skills", "review", "SKILL.md"), "utf8")).toBe(theirs);
    expect(await git(worktree, "status", "--porcelain")).toBe("");
  });

  it("keeps a copy git tracks even when it still matches ZLI's copy", async () => {
    const { worktree, store } = await setup();
    await initRepository(worktree);
    await store.save({ kind: "user" }, undefined, review);
    await git(worktree, "add", "-f", ".agents/skills/review");
    await git(worktree, "commit", "-m", "keep the review skill");
    await store.removeCopies();
    expect(await readFile(join(worktree, ".agents", "skills", "review", "SKILL.md"), "utf8")).toBe(reviewFile);
    expect(await readdir(join(worktree, ".claude", "skills"))).toEqual([]);
  });

  it("loads copies recorded by name only, and records a digest from then on", async () => {
    const { data, worktree, options } = await setup();
    const shared = join(worktree, ".agents", "skills");
    await mkdir(join(shared, "old"), { recursive: true });
    await writeFile(join(shared, "old", "SKILL.md"), "---\nname: old\ndescription: Old.\n---\n");
    await mkdir(data, { recursive: true });
    await writeFile(
      options.statePath,
      JSON.stringify({ version: 1, disabled: [], sources: {}, owned: {}, copies: { [shared]: ["old"] } }),
    );
    const store = new SkillStore(options);
    await store.load();
    await store.save({ kind: "user" }, undefined, review);
    expect(await readdir(shared)).toEqual(["review"]);
    const copies = JSON.parse(await readFile(options.statePath, "utf8")).copies;
    expect(copies[shared]).toEqual({ review: expect.stringMatching(/^[0-9a-f]{64}$/u) });
  });

  it.skipIf(process.platform === "win32")("does not copy into a skills folder behind a link", async () => {
    const { root, worktree, store } = await setup();
    const elsewhere = join(root, "elsewhere");
    await mkdir(elsewhere);
    await symlink(elsewhere, join(worktree, ".claude"), "dir");
    await store.save({ kind: "user" }, undefined, review);
    expect(await readdir(elsewhere)).toEqual([]);
    expect(await readdir(join(worktree, ".agents", "skills"))).toEqual(["review"]);
    expect((await store.list()).sync.outcomes).toEqual([
      {
        path: join(worktree, ".claude", "skills"),
        agents: ["claude-code"],
        status: "failed",
        conflicts: [],
        message: "it or a folder above it is a link, so ZLI left it alone",
      },
    ]);
  });

  it.skipIf(process.platform === "win32")("stops owning a copy once a link replaces a folder above it", async () => {
    const { root, worktree, store } = await setup();
    await store.save({ kind: "user" }, undefined, review);
    const elsewhere = join(root, "elsewhere");
    await mkdir(join(elsewhere, "skills", "review"), { recursive: true });
    await writeFile(join(elsewhere, "skills", "review", "SKILL.md"), reviewFile);
    await rm(join(worktree, ".claude"), { recursive: true });
    await symlink(elsewhere, join(worktree, ".claude"), "dir");
    await store.removeCopies();
    expect(await readFile(join(elsewhere, "skills", "review", "SKILL.md"), "utf8")).toBe(reviewFile);
    expect(await readdir(join(worktree, ".agents", "skills"))).toEqual([]);
  });

  it("keeps disabled skills across restarts and reports a damaged settings file", async () => {
    const { options, store } = await setup();
    await store.save({ kind: "user" }, undefined, review);
    await store.setEnabled("review", false);
    const reloaded = new SkillStore(options);
    await reloaded.load();
    expect((await reloaded.list()).skills[0]?.enabled).toBe(false);

    await writeFile(options.statePath, "{ nope");
    const broken = new SkillStore(options);
    await broken.load();
    expect((await broken.list()).problem).toBe("ZLI's skill settings are not valid JSON.");
  });

  it("writes project skills to .agents/skills in the repository and lists the other agent folders", async () => {
    const { project, store } = await setup();
    const ref = projectRef(project);
    await store.save({ kind: "project", project: ref }, undefined, review);
    expect(await readFile(join(project, ".agents", "skills", "review", "SKILL.md"), "utf8")).toContain("name: review");
    await mkdir(join(project, ".claude", "skills", "deploy"), { recursive: true });
    await writeFile(
      join(project, ".claude", "skills", "deploy", "SKILL.md"),
      "---\nname: deploy\ndescription: Ship it.\n---\n",
    );
    await mkdir(join(project, ".github", "skills", "broken"), { recursive: true });
    await writeFile(join(project, ".github", "skills", "broken", "SKILL.md"), "no frontmatter");

    const listed = await store.list(ref);
    expect(listed.project).toEqual({ ...ref, skillsPath: join(project, ".agents", "skills") });
    expect(listed.skills).toEqual([expect.objectContaining({ name: "review", scope: "project", enabled: true })]);
    expect(listed.found.map((skill) => [skill.name, skill.dir, skill.problem])).toEqual([
      ["deploy", ".claude/skills", undefined],
      ["broken", ".github/skills", "SKILL.md has no frontmatter with a name and description."],
    ]);
    await store.delete({ kind: "project", project: ref }, "review");
    expect(await readdir(join(project, ".agents", "skills"))).toEqual([]);
  });

  it("shows what a GitHub folder holds, then installs the chosen skills", async () => {
    const tarball = githubTarball([
      { path: "skills/pdf/SKILL.md", text: "---\nname: pdf\ndescription: Fill PDFs.\n---\nUse fill.py\n" },
      { path: "skills/pdf/scripts/fill.py", text: "print('fill')\n" },
      { path: "skills/bad/SKILL.md", text: "# no frontmatter" },
    ]);
    const seen: string[] = [];
    const { worktree, data, store } = await setup(fakeFetch(tarball, seen));
    const preview = await store.previewInstall("https://github.com/o/r/tree/main/skills");
    expect(preview).toEqual({
      owner: "o",
      repo: "r",
      ref: "main",
      path: "skills",
      candidates: [
        expect.objectContaining({ name: "bad", problem: expect.any(String) }),
        {
          name: "pdf",
          description: "Fill PDFs.",
          path: "skills/pdf",
          files: 2,
          bytes: expect.any(Number),
          exists: false,
        },
      ],
    });
    await expect(store.install("o/r/tree/main/skills", { kind: "user" }, ["bad"])).rejects.toThrow(/^bad: /u);
    expect(await store.install("https://github.com/o/r/tree/main/skills", { kind: "user" }, ["pdf"])).toEqual(["pdf"]);
    // The preview's download is reused.
    expect(seen).toHaveLength(1);
    expect(await readFile(join(data, "skills", "pdf", "scripts", "fill.py"), "utf8")).toBe("print('fill')\n");
    expect(await readFile(join(worktree, ".claude", "skills", "pdf", "scripts", "fill.py"), "utf8")).toBe(
      "print('fill')\n",
    );
    const listed = await store.list();
    expect(listed.skills[0]).toMatchObject({ name: "pdf", source: "https://github.com/o/r/tree/main/skills/pdf" });
    expect((await store.previewInstall("https://github.com/o/r/tree/main/skills")).candidates[1]?.exists).toBe(true);
  });

  it("does not copy links out of the library", async () => {
    const { worktree, data, store } = await setup();
    await store.save({ kind: "user" }, undefined, review);
    await writeFile(join(data, "secret.txt"), "secret");
    await symlink(join(data, "secret.txt"), join(data, "skills", "review", "link.txt"));
    await store.syncCopies();
    expect((await readdir(join(worktree, ".claude", "skills", "review"))).sort()).toEqual(["SKILL.md"]);
  });
});

describe("runSkillCommand", () => {
  it("resolves projects for project scope and lists the project the client shows", async () => {
    const { project, store } = await setup();
    const { projectId } = projectRef(project);
    const lookup = async (id: string) => (id === projectId ? project : undefined);
    const saved = (await runSkillCommand(
      store,
      {
        type: "skills.save",
        scope: { kind: "project", projectId },
        skill: { name: "review", description: "Reviews.", instructions: "" },
      },
      lookup,
    )) as Awaited<ReturnType<SkillStore["list"]>>;
    expect(saved.project?.path).toBe(project);
    expect(saved.skills.map((skill) => skill.scope)).toEqual(["project"]);

    const listed = (await runSkillCommand(store, { type: "skills.list" }, lookup)) as typeof saved;
    expect(listed.project).toBeUndefined();
    await expect(
      runSkillCommand(
        store,
        { type: "skills.list", projectId: "22222222-2222-4222-8222-222222222222" as ProjectId },
        lookup,
      ),
    ).rejects.toThrow("Project does not exist.");
  });
});
