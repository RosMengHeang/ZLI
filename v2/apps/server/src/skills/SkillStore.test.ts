import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ListedProviderKind, ProjectId } from "@zli-v2/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { runSkillCommand } from "./runSkillCommand.js";
import { SkillStore } from "./SkillStore.js";
import { fakeFetch, githubTarball } from "./testTarball.js";
import { skillSyncTargets, syncUserSkills } from "./userSkillSync.js";

const temps: string[] = [];
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function setup(installed: ListedProviderKind[] = ["claude-code", "codex"], fetchImpl?: typeof fetch) {
  const root = await mkdtemp(join(tmpdir(), "zli-skills-"));
  temps.push(root);
  const home = join(root, "home");
  const data = join(root, "data");
  const project = join(root, "repo");
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
  const options = {
    libraryDir: join(data, "skills"),
    statePath: join(data, "skills.json"),
    home,
    env: {},
    sync: (skills: ReadonlyArray<{ name: string; path: string }>, owned: Record<string, readonly string[]>) =>
      syncUserSkills(skills, owned, { home, env: {}, isInstalled: async (provider) => installed.includes(provider) }),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  };
  const store = new SkillStore(options);
  await store.load();
  return { root, home, data, project, options, store };
}

const review = { name: "review", description: "Review a diff for bugs.", instructions: "# Review\n\nRead the diff." };
const projectRef = (path: string) => ({ projectId: "11111111-1111-4111-8111-111111111111" as ProjectId, path });

describe("skill sync targets", () => {
  it("copies once into the shared folder and into Claude Code's own folder", () => {
    const targets = skillSyncTargets("/home/me", { KIMI_CODE_HOME: "/kimi" });
    expect(targets.map((target) => target.path)).toEqual(["/home/me/.agents/skills", "/home/me/.claude/skills"]);
    expect(targets[0]?.agents).toEqual([
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
  });
});

describe("SkillStore", () => {
  it("saves a user skill and copies it into installed agents' folders", async () => {
    const { home, data, store } = await setup();
    await store.save({ kind: "user" }, undefined, review);
    const text = await readFile(join(data, "skills", "review", "SKILL.md"), "utf8");
    expect(text).toBe("---\nname: review\ndescription: Review a diff for bugs.\n---\n\n# Review\n\nRead the diff.\n");
    expect(await readFile(join(home, ".claude", "skills", "review", "SKILL.md"), "utf8")).toBe(text);
    expect(await readFile(join(home, ".agents", "skills", "review", "SKILL.md"), "utf8")).toBe(text);

    const listed = await store.list();
    expect(listed.skills).toEqual([
      {
        name: "review",
        description: "Review a diff for bugs.",
        scope: "user",
        enabled: true,
        path: join(data, "skills", "review"),
      },
    ]);
    // ZLI's own copies are not reported as skills found in agent folders.
    expect(listed.found).toEqual([]);
    expect(listed.sync.outcomes.map((outcome) => outcome.status)).toEqual(["updated", "updated"]);
    expect(await store.read({ kind: "user" }, "review")).toMatchObject({
      instructions: "# Review\n\nRead the diff.",
      files: [],
    });

    await expect(store.save({ kind: "user" }, undefined, review)).rejects.toThrow(
      "A skill named review already exists.",
    );
  });

  it("never overwrites the person's own skill and lists it as found", async () => {
    const { home, store } = await setup(["claude-code"]);
    const theirs = join(home, ".claude", "skills", "review");
    await mkdir(theirs, { recursive: true });
    await writeFile(join(theirs, "SKILL.md"), "---\nname: review\ndescription: Mine.\n---\nMine\n");
    await store.save({ kind: "user" }, undefined, review);
    expect(await readFile(join(theirs, "SKILL.md"), "utf8")).toContain("Mine.");
    const listed = await store.list();
    expect(listed.skills[0]?.conflicts).toEqual([join(home, ".claude", "skills")]);
    expect(listed.sync.outcomes).toEqual([
      { path: join(home, ".agents", "skills"), agents: expect.any(Array), status: "skipped-absent", conflicts: [] },
      { path: join(home, ".claude", "skills"), agents: ["claude-code"], status: "unchanged", conflicts: ["review"] },
    ]);
    expect(listed.found).toEqual([
      expect.objectContaining({ name: "review", description: "Mine.", scope: "user", dir: ".claude/skills" }),
    ]);
    expect(listed.found[0]?.agents).toEqual(["claude-code", "cursor-agent", "opencode", "goose"]);

    await store.delete({ kind: "user" }, "review");
    expect(await readFile(join(theirs, "SKILL.md"), "utf8")).toContain("Mine.");
  });

  it("removes only its own copies when a skill is turned off, renamed, or deleted", async () => {
    const { home, options, store } = await setup(["claude-code"]);
    const claude = join(home, ".claude", "skills");
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

  it("keeps disabled skills across restarts and reports a damaged settings file", async () => {
    const { options, store } = await setup([]);
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
    const { home, data, store } = await setup(["claude-code"], fakeFetch(tarball, seen));
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
    expect(await readFile(join(home, ".claude", "skills", "pdf", "scripts", "fill.py"), "utf8")).toBe(
      "print('fill')\n",
    );
    const listed = await store.list();
    expect(listed.skills[0]).toMatchObject({ name: "pdf", source: "https://github.com/o/r/tree/main/skills/pdf" });
    expect((await store.previewInstall("https://github.com/o/r/tree/main/skills")).candidates[1]?.exists).toBe(true);
  });

  it("does not copy links out of the library", async () => {
    const { home, data, store } = await setup(["claude-code"]);
    await store.save({ kind: "user" }, undefined, review);
    await writeFile(join(data, "secret.txt"), "secret");
    await symlink(join(data, "secret.txt"), join(data, "skills", "review", "link.txt"));
    await store.syncUserSettings();
    expect((await readdir(join(home, ".claude", "skills", "review"))).sort()).toEqual(["SKILL.md"]);
  });
});

describe("runSkillCommand", () => {
  it("resolves projects for project scope and lists the project the client shows", async () => {
    const { project, store } = await setup([]);
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
