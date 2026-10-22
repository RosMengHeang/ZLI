import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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

async function setup() {
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
  const checkpoints = new TurnCheckpoints(engine, git);
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

  it("skips turns that changed nothing", async () => {
    const { engine, checkpoints } = await setup();
    const start = await checkpoints.capture(threadId);
    if (!start) throw new Error("Expected a starting snapshot.");
    await checkpoints.record(threadId, "turn-1", start);
    expect((await engine.projection()).checkpoints ?? []).toEqual([]);
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
