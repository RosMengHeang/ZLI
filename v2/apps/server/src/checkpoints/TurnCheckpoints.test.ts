import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CommandId, EnvironmentId, ProjectId, ThreadId, WorktreeId } from "@zli-v2/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { Database } from "../db/Database.js";
import { GitProcess } from "../git/GitProcess.js";
import { Engine } from "../orchestration/Engine.js";
import { parseNameStatus, TurnCheckpoints } from "./TurnCheckpoints.js";

const environment = {
  environmentId: EnvironmentId.parse("00000000-0000-4000-8000-000000000a01"),
  label: "Checkpoint test",
  protocolVersion: 1 as const,
  capabilities: {},
};
const worktreeId = WorktreeId.parse("00000000-0000-4000-8000-000000000a02");
const threadId = ThreadId.parse("00000000-0000-4000-8000-000000000a03");

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function setup(options?: ConstructorParameters<typeof TurnCheckpoints>[2]) {
  const directory = await mkdtemp(join(tmpdir(), "zli-checkpoints-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const repo = join(directory, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  const git = new GitProcess();
  await git.run(["init"], { cwd: repo });
  for (const [key, value] of [
    ["user.email", "zli-checkpoints@example.invalid"],
    ["user.name", "ZLI Checkpoints"],
    ["core.autocrlf", "false"],
    ["commit.gpgsign", "false"],
  ]) {
    await git.run(["config", key as string, value as string], { cwd: repo });
  }
  await writeFile(join(repo, "README.md"), "base\n");
  await writeFile(join(repo, "src", "old.txt"), "old\n");
  await git.run(["add", "--all"], { cwd: repo });
  await git.run(["commit", "-m", "base"], { cwd: repo });

  const database = new Database({ path: ":memory:" });
  cleanup.push(() => database.close());
  const engine = new Engine({ database, environment });
  let sequence = 0;
  const dispatch = (command: Parameters<Engine["dispatchPromise"]>[0]["command"]) => {
    sequence += 1;
    return engine.dispatchPromise({
      protocolVersion: 1,
      commandId: CommandId.parse(`20000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`),
      command,
    });
  };
  await dispatch({ type: "project.register", path: repo });
  const project = (await engine.projection()).projects[0];
  if (!project) throw new Error("Expected the registered project.");
  await dispatch({
    type: "worktree.create",
    worktreeId,
    projectId: ProjectId.parse(project.projectId),
    path: repo,
    workspaceRoot: directory,
    branch: "main",
  });
  await dispatch({ type: "worktree.status", worktreeId, status: "ready" });
  await dispatch({ type: "thread.start", threadId, worktreeId, provider: "codex", cwd: repo });
  const checkpoints = new TurnCheckpoints(engine, git, options);
  cleanup.push(() => checkpoints.stop());
  return { repo, git, engine, dispatch, checkpoints };
}

describe("TurnCheckpoints", () => {
  it("records a turn's changes, shows a file's diff, and restores the files", async () => {
    const { repo, git, engine, dispatch, checkpoints } = await setup();
    // Staged work belongs to the person; snapshots and restores must leave the real index alone.
    await writeFile(join(repo, "staged.txt"), "staged\n");
    await git.run(["add", "staged.txt"], { cwd: repo });
    const stagedBefore = (await git.run(["diff", "--cached", "--name-only"], { cwd: repo })).stdout;

    const start = await checkpoints.capture(threadId);
    if (!start) throw new Error("Expected a starting snapshot.");
    await writeFile(join(repo, "README.md"), "changed\nmore\n");
    await mkdir(join(repo, "notes"));
    await writeFile(join(repo, "notes", "new.md"), "new\n");
    await rm(join(repo, "src", "old.txt"));
    await checkpoints.record(threadId, "turn-1", start);

    const [checkpoint] = (await engine.projection()).checkpoints ?? [];
    expect(checkpoint).toMatchObject({
      threadId,
      worktreeId,
      turnId: "turn-1",
      fileCount: 3,
      additions: 3,
      deletions: 2,
    });
    expect(checkpoint?.files.map((file) => [file.path, file.kind])).toEqual([
      ["README.md", "modified"],
      ["notes/new.md", "added"],
      ["src/old.txt", "deleted"],
    ]);
    if (!checkpoint) throw new Error("Expected a checkpoint.");

    const diff = await checkpoints.diff(checkpoint.checkpointId, "README.md");
    expect(diff.patch).toContain("-base");
    expect(diff.patch).toContain("+changed");
    await expect(checkpoints.diff(checkpoint.checkpointId, "staged.txt")).rejects.toThrow(
      "That file did not change in this turn.",
    );

    await dispatch({ type: "thread.status", threadId, status: "working" });
    await expect(checkpoints.restore(checkpoint.checkpointId)).rejects.toThrow("An agent is working");
    await dispatch({ type: "thread.status", threadId, status: "idle" });

    await writeFile(join(repo, "README.md"), "edited again by the person\n");
    expect(await checkpoints.restore(checkpoint.checkpointId)).toEqual({ changedFiles: 3 });
    expect(await readFile(join(repo, "README.md"), "utf8")).toBe("base\n");
    expect(await readFile(join(repo, "src", "old.txt"), "utf8")).toBe("old\n");
    await expect(stat(join(repo, "notes"))).rejects.toThrow();
    expect(await readFile(join(repo, "staged.txt"), "utf8")).toBe("staged\n");
    expect((await git.run(["diff", "--cached", "--name-only"], { cwd: repo })).stdout).toBe(stagedBefore);
    const messages = (await engine.projection()).messages ?? [];
    expect(messages.at(-1)).toMatchObject({ role: "system", text: expect.stringContaining("Restored 3 files") });
    const refs = await git.run(["for-each-ref", "--format=%(refname)", `refs/zli/checkpoints/${threadId}/`], {
      cwd: repo,
    });
    expect(refs.stdout.trim().split(/\r?\n/u)).toHaveLength(3);
  }, 20_000);

  it("shows one file's diff across several turns", async () => {
    const { repo, engine, checkpoints } = await setup();
    const first = await checkpoints.capture(threadId);
    if (!first) throw new Error("Expected a starting snapshot.");
    await writeFile(join(repo, "README.md"), "first\n");
    await checkpoints.record(threadId, "turn-1", first);
    const second = await checkpoints.capture(threadId);
    if (!second) throw new Error("Expected a starting snapshot.");
    await writeFile(join(repo, "README.md"), "second\n");
    await checkpoints.record(threadId, "turn-2", second);

    const [one, two] = (await engine.projection()).checkpoints ?? [];
    if (!one || !two) throw new Error("Expected two checkpoints.");
    const diff = await checkpoints.diff(one.checkpointId, "README.md", two.checkpointId);
    expect(diff.patch).toContain("-base");
    expect(diff.patch).toContain("+second");
    expect(diff.patch).not.toContain("first");
  });

  it("copies a worktree's current files, or a turn's starting files, into a new worktree", async () => {
    const { repo, git, engine, dispatch, checkpoints } = await setup();
    const start = await checkpoints.capture(threadId);
    if (!start) throw new Error("Expected a starting snapshot.");
    await writeFile(join(repo, "README.md"), "turn one\n");
    await checkpoints.record(threadId, "turn-1", start);
    const [checkpoint] = (await engine.projection()).checkpoints ?? [];
    if (!checkpoint) throw new Error("Expected a checkpoint.");
    // Not committed: a run has to start from what the person sees, not from the branch.
    await writeFile(join(repo, "draft.txt"), "draft\n");
    await rm(join(repo, "src", "old.txt"));

    const runPath = join(repo, "..", "run1");
    await git.run(["worktree", "add", "-b", "main-run1", runPath], { cwd: repo });
    const project = (await engine.projection()).projects[0];
    if (!project) throw new Error("Expected the registered project.");
    const runWorktreeId = WorktreeId.parse("00000000-0000-4000-8000-000000000a04");
    await dispatch({
      type: "worktree.create",
      worktreeId: runWorktreeId,
      projectId: ProjectId.parse(project.projectId),
      path: runPath,
      workspaceRoot: join(repo, ".."),
      branch: "main-run1",
    });
    await expect(
      checkpoints.fork({ type: "checkpoint.fork", worktreeId: runWorktreeId, from: { kind: "worktree", worktreeId } }),
    ).rejects.toThrow("The new worktree is not ready.");
    await dispatch({ type: "worktree.status", worktreeId: runWorktreeId, status: "ready" });

    expect(
      await checkpoints.fork({
        type: "checkpoint.fork",
        worktreeId: runWorktreeId,
        from: { kind: "worktree", worktreeId },
      }),
    ).toEqual({ changedFiles: 3 });
    expect(await readFile(join(runPath, "README.md"), "utf8")).toBe("turn one\n");
    expect(await readFile(join(runPath, "draft.txt"), "utf8")).toBe("draft\n");
    await expect(stat(join(runPath, "src", "old.txt"))).rejects.toThrow();
    expect(await readFile(join(repo, "draft.txt"), "utf8")).toBe("draft\n");

    expect(
      await checkpoints.fork({
        type: "checkpoint.fork",
        worktreeId: runWorktreeId,
        from: { kind: "checkpoint", checkpointId: checkpoint.checkpointId },
      }),
    ).toEqual({ changedFiles: 3 });
    expect(await readFile(join(runPath, "README.md"), "utf8")).toBe("base\n");
    expect(await readFile(join(runPath, "src", "old.txt"), "utf8")).toBe("old\n");
    await expect(stat(join(runPath, "draft.txt"))).rejects.toThrow();
  }, 30_000);

  it("skips turns that changed nothing", async () => {
    const { engine, checkpoints } = await setup();
    const start = await checkpoints.capture(threadId);
    if (!start) throw new Error("Expected a starting snapshot.");
    await checkpoints.record(threadId, "turn-1", start);
    expect((await engine.projection()).checkpoints ?? []).toEqual([]);
  }, 20_000);

  it("leaves oversized untracked paths out of snapshots", async () => {
    const { repo, git, checkpoints } = await setup({ limits: { maxFileBytes: 1024, maxFolderFiles: 3 } });
    await writeFile(join(repo, "huge.bin"), "x".repeat(2048));
    await mkdir(join(repo, "target"));
    for (let index = 0; index < 4; index += 1) await writeFile(join(repo, "target", `f${index}.o`), "o\n");
    const start = await checkpoints.capture(threadId);
    if (!start) throw new Error("Expected a starting snapshot.");
    const paths = (await git.run(["ls-tree", "-r", "--name-only", start.tree], { cwd: repo })).stdout.split("\n");
    expect(paths).toContain("README.md");
    expect(paths).not.toContain("huge.bin");
    expect(paths.some((path) => path.startsWith("target/"))).toBe(false);
  }, 20_000);

  it("restore never deletes a skipped file that was staged after the turn began", async () => {
    const { repo, git, engine, checkpoints } = await setup({ limits: { maxFileBytes: 1024, maxFolderFiles: 3 } });
    await writeFile(join(repo, "huge.bin"), "x".repeat(2048));
    const start = await checkpoints.capture(threadId);
    if (!start) throw new Error("Expected a starting snapshot.");
    // Staged mid-turn: the real index now holds the file the snapshots leave out.
    await git.run(["add", "huge.bin"], { cwd: repo });
    await writeFile(join(repo, "README.md"), "changed\n");
    await checkpoints.record(threadId, "turn-1", start);
    const [checkpoint] = (await engine.projection()).checkpoints ?? [];
    if (!checkpoint) throw new Error("Expected a checkpoint.");
    expect(checkpoint.files.map((file) => file.path)).toEqual(["README.md"]);
    await checkpoints.restore(checkpoint.checkpointId);
    expect(await readFile(join(repo, "huge.bin"), "utf8")).toBe("x".repeat(2048));
    expect(await readFile(join(repo, "README.md"), "utf8")).toBe("base\n");
  }, 20_000);

  it("sweeps old temp objects on the first snapshot", async () => {
    const { repo, checkpoints } = await setup();
    const stale = join(repo, ".git", "objects", "tmp_objdir-bulk-fsync-stale");
    await mkdir(stale);
    await writeFile(join(stale, "x"), "x");
    const old = new Date(Date.now() - 11 * 60_000);
    await utimes(stale, old, old);
    await checkpoints.capture(threadId);
    await expect(stat(stale)).rejects.toThrow();
  }, 20_000);

  it("restore never touches a folder that grew past the limit", async () => {
    const { repo, engine, checkpoints } = await setup({ limits: { maxFileBytes: 1024, maxFolderFiles: 3 } });
    await mkdir(join(repo, "gen"));
    await writeFile(join(repo, "gen", "a.txt"), "a\n");
    await writeFile(join(repo, "gen", "b.txt"), "b\n");
    const start = await checkpoints.capture(threadId);
    if (!start) throw new Error("Expected a starting snapshot.");
    await writeFile(join(repo, "gen", "c.txt"), "c\n");
    await writeFile(join(repo, "gen", "d.txt"), "d\n");
    await writeFile(join(repo, "README.md"), "changed\n");
    await checkpoints.record(threadId, "turn-1", start);
    const [checkpoint] = (await engine.projection()).checkpoints ?? [];
    if (!checkpoint) throw new Error("Expected a checkpoint.");
    // The folder left the snapshot mid-turn; that is not the agent deleting it.
    expect(checkpoint.files.map((file) => file.path)).toEqual(["README.md"]);
    await checkpoints.restore(checkpoint.checkpointId);
    for (const name of ["a", "b", "c", "d"]) {
      expect(await readFile(join(repo, "gen", `${name}.txt`), "utf8")).toBe(`${name}\n`);
    }
    expect(await readFile(join(repo, "README.md"), "utf8")).toBe("base\n");
  }, 20_000);

  it("restore never deletes a folder that shrank under the limit", async () => {
    const { repo, engine, checkpoints } = await setup({ limits: { maxFileBytes: 1024, maxFolderFiles: 3 } });
    await mkdir(join(repo, "gen"));
    for (const name of ["a", "b", "c", "d"]) await writeFile(join(repo, "gen", `${name}.txt`), `${name}\n`);
    const start = await checkpoints.capture(threadId);
    if (!start) throw new Error("Expected a starting snapshot.");
    await rm(join(repo, "gen", "d.txt"));
    await writeFile(join(repo, "README.md"), "changed\n");
    await checkpoints.record(threadId, "turn-1", start);
    const [checkpoint] = (await engine.projection()).checkpoints ?? [];
    if (!checkpoint) throw new Error("Expected a checkpoint.");
    expect(checkpoint.files.map((file) => file.path)).toEqual(["README.md"]);
    await checkpoints.restore(checkpoint.checkpointId);
    for (const name of ["a", "b", "c"]) {
      expect(await readFile(join(repo, "gen", `${name}.txt`), "utf8")).toBe(`${name}\n`);
    }
    expect(await readFile(join(repo, "README.md"), "utf8")).toBe("base\n");
  }, 20_000);

  it("restore keeps a folder that shrank after the turn", async () => {
    const { repo, engine, checkpoints } = await setup({ limits: { maxFileBytes: 1024, maxFolderFiles: 3 } });
    await mkdir(join(repo, "gen"));
    for (const name of ["a", "b", "c", "d"]) await writeFile(join(repo, "gen", `${name}.txt`), `${name}\n`);
    const start = await checkpoints.capture(threadId);
    if (!start) throw new Error("Expected a starting snapshot.");
    await writeFile(join(repo, "README.md"), "changed\n");
    await checkpoints.record(threadId, "turn-1", start);
    const [checkpoint] = (await engine.projection()).checkpoints ?? [];
    if (!checkpoint) throw new Error("Expected a checkpoint.");
    await rm(join(repo, "gen", "d.txt"));
    await checkpoints.restore(checkpoint.checkpointId);
    for (const name of ["a", "b", "c"]) {
      expect(await readFile(join(repo, "gen", `${name}.txt`), "utf8")).toBe(`${name}\n`);
    }
  }, 20_000);
});

describe("parseNameStatus", () => {
  it("reads plain entries and renames", () => {
    expect(parseNameStatus("M\0a.ts\0R087\0old.ts\0new.ts\0D\0gone.ts\0")).toEqual([
      { status: "M", path: "a.ts" },
      { status: "R", path: "new.ts", oldPath: "old.ts" },
      { status: "D", path: "gone.ts" },
    ]);
  });
});
