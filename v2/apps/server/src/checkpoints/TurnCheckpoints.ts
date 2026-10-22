import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  type CheckpointCommand,
  CheckpointDiffResult,
  CheckpointRestoreResult,
  CommandId,
  MAX_CHECKPOINT_FILES,
  type RuntimeProjection,
  type ThreadCheckpoint,
  ThreadId,
  type TurnCheckpointFile,
  WorktreeId,
} from "@zli-v2/contracts";

import type { GitProcess } from "../git/GitProcess.js";
import type { Engine } from "../orchestration/Engine.js";
import { parseNumstat } from "../review/ReviewService.js";

/** A message the person can act on; anything else is reported as an unexpected failure. */
export class CheckpointError extends Error {}

/** The worktree's files as a Git tree, taken before the agent saw the message. */
export type TurnStart = { worktreeId: string; worktreePath: string; tree: string };

type NameStatus = { status: string; path: string; oldPath?: string };

const REF_ROOT = "refs/zli/checkpoints";
const SNAPSHOT_TIMEOUT_MS = 60_000;
const CHECKOUT_BATCH = 100;
const MAX_PATCH_CHARS = 200_000;
const MAX_TURN_ID = 200;
const BUSY_STATUSES = new Set(["working", "waiting"]);

/**
 * Saves the worktree's files before and after each agent turn, so a turn's changes can be shown
 * on their own and the files put back to how they were. Snapshots are Git trees written through a
 * temporary index, so the person's staged changes are never touched. Refs keep the trees from
 * being garbage collected until the session is deleted.
 */
export class TurnCheckpoints {
  private readonly tasks = new Set<Promise<void>>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly engine: Engine,
    private readonly git: Pick<GitProcess, "run">,
  ) {
    this.unsubscribe = engine.subscribe((envelope) => {
      if (envelope.event.type === "session.deleted") this.track(this.dropRefs(envelope.event.threadIds));
    });
  }

  stop(): void {
    this.unsubscribe();
  }

  async waitForIdle(): Promise<void> {
    while (this.tasks.size > 0) await Promise.all([...this.tasks]);
  }

  /** Never throws: a turn without a starting snapshot simply gets no checkpoint. */
  async capture(threadId: string): Promise<TurnStart | undefined> {
    try {
      const projection = await this.engine.projection();
      const thread = projection.threads.find((candidate) => candidate.threadId === threadId);
      const worktree = projection.worktrees.find((candidate) => candidate.worktreeId === thread?.worktreeId);
      if (worktree?.status !== "ready") return undefined;
      const tree = await this.snapshot(worktree.path);
      return { worktreeId: worktree.worktreeId, worktreePath: worktree.path, tree };
    } catch {
      return undefined;
    }
  }

  /** Records the turn when its files differ from the starting snapshot. Never throws. */
  async record(threadId: string, turnId: string, start: TurnStart): Promise<void> {
    try {
      const cwd = start.worktreePath;
      const end = await this.snapshot(cwd);
      if (end === start.tree) return;
      const { files, fileCount, additions, deletions } = await this.changes(cwd, start.tree, end);
      if (fileCount === 0) return;
      const checkpointId = randomUUID();
      const refs = `${REF_ROOT}/${threadId}/${checkpointId}`;
      await this.git.run(["update-ref", `${refs}/start`, start.tree], { cwd });
      await this.git.run(["update-ref", `${refs}/end`, end], { cwd });
      const checkpoint: Omit<ThreadCheckpoint, "recordedAt"> = {
        checkpointId,
        threadId: ThreadId.parse(threadId),
        worktreeId: WorktreeId.parse(start.worktreeId),
        turnId: boundedTurnId(turnId),
        startTree: start.tree,
        endTree: end,
        files,
        fileCount,
        additions,
        deletions,
      };
      await this.engine.dispatchPromise({
        protocolVersion: 1,
        commandId: CommandId.parse(randomUUID()),
        command: { type: "thread.checkpoint", checkpoint },
      });
    } catch {
      // The session may have been deleted mid-turn, or the folder is no longer a Git checkout.
    }
  }

  async run(command: CheckpointCommand): Promise<unknown> {
    switch (command.type) {
      case "checkpoint.diff":
        return this.diff(command.checkpointId, command.path);
      case "checkpoint.restore":
        return this.restore(command.checkpointId);
    }
  }

  async diff(checkpointId: string, path: string): Promise<CheckpointDiffResult> {
    const { checkpoint, worktreePath } = await this.lookup(checkpointId);
    const file = checkpoint.files.find((candidate) => candidate.path === path);
    if (!file) throw new CheckpointError("That file did not change in this turn.");
    const paths = file.oldPath ? [file.oldPath, file.path] : [file.path];
    const result = await this.readTrees(() =>
      this.git.run(
        [
          "diff",
          "--no-ext-diff",
          "--no-color",
          "--unified=3",
          "--find-renames",
          checkpoint.startTree,
          checkpoint.endTree,
          "--",
          ...paths,
        ],
        { cwd: worktreePath },
      ),
    );
    const truncated = result.stdout.length > MAX_PATCH_CHARS;
    return CheckpointDiffResult.parse({
      path: file.path,
      ...(file.oldPath ? { oldPath: file.oldPath } : {}),
      binary: file.binary,
      patch: truncated ? result.stdout.slice(0, MAX_PATCH_CHARS) : result.stdout,
      truncated,
    });
  }

  /**
   * Puts every file back to how it was when the turn started, including later turns' changes and
   * the person's own edits. The files as they were just before the restore are kept under a ref.
   */
  async restore(checkpointId: string): Promise<CheckpointRestoreResult> {
    const { checkpoint, worktreePath: cwd, projection } = await this.lookup(checkpointId);
    const busy = projection.threads.some(
      (thread) => thread.worktreeId === checkpoint.worktreeId && BUSY_STATUSES.has(thread.status),
    );
    if (busy) {
      throw new CheckpointError("An agent is working in this worktree. Wait for its turn to end, then restore.");
    }
    const current = await this.snapshot(cwd);
    if (current === checkpoint.startTree) return { changedFiles: 0 };
    const diff = await this.readTrees(() =>
      this.git.run(["diff-tree", "-r", "-z", "--no-renames", "--name-status", current, checkpoint.startTree], {
        cwd,
      }),
    );
    await this.git.run(["update-ref", `${REF_ROOT}/${checkpoint.threadId}/${checkpointId}/before-restore`, current], {
      cwd,
    });
    const changes = parseNameStatus(diff.stdout);
    for (const change of changes.filter((entry) => entry.status === "D")) {
      await rm(join(cwd, change.path), { force: true });
      await removeEmptyParents(cwd, change.path);
    }
    const written = changes.filter((entry) => entry.status !== "D").map((entry) => entry.path);
    if (written.length > 0) {
      await this.withIndex(async (env) => {
        await this.git.run(["read-tree", checkpoint.startTree], { cwd, env });
        for (let index = 0; index < written.length; index += CHECKOUT_BATCH) {
          const batch = written.slice(index, index + CHECKOUT_BATCH);
          await this.git.run(["checkout-index", "--force", "--", ...batch], { cwd, env });
        }
      });
    }
    const count = changes.length;
    await this.engine.dispatchPromise({
      protocolVersion: 1,
      commandId: CommandId.parse(randomUUID()),
      command: {
        type: "thread.message",
        message: {
          messageId: randomUUID(),
          threadId: checkpoint.threadId,
          role: "system",
          text: `Restored ${count} ${count === 1 ? "file" : "files"} to how they were before an earlier turn. The agent was not told.`,
        },
      },
    });
    return CheckpointRestoreResult.parse({ changedFiles: count });
  }

  private async lookup(checkpointId: string): Promise<{
    checkpoint: ThreadCheckpoint;
    worktreePath: string;
    projection: RuntimeProjection;
  }> {
    const projection = await this.engine.projection();
    const checkpoint = projection.checkpoints?.find((candidate) => candidate.checkpointId === checkpointId);
    if (!checkpoint) throw new CheckpointError("This turn's changes are no longer saved.");
    const worktree = projection.worktrees.find((candidate) => candidate.worktreeId === checkpoint.worktreeId);
    if (!worktree) throw new CheckpointError("The worktree for this turn was removed.");
    if (worktree.status !== "ready") throw new CheckpointError("The worktree is not ready.");
    return { checkpoint, worktreePath: worktree.path, projection };
  }

  /** `git add --all` into a copy of the real index, so unchanged files are not hashed again. */
  private async snapshot(cwd: string): Promise<string> {
    const indexPath = (await this.git.run(["rev-parse", "--git-path", "index"], { cwd })).stdout.trim();
    return this.withIndex(async (env) => {
      try {
        await copyFile(resolve(cwd, indexPath), env.GIT_INDEX_FILE);
      } catch {
        // A repository without commits or staged files has no index yet.
      }
      await this.git.run(["add", "--all", "--", "."], { cwd, env, timeoutMs: SNAPSHOT_TIMEOUT_MS });
      return (await this.git.run(["write-tree"], { cwd, env })).stdout.trim();
    });
  }

  private async withIndex<T>(work: (env: { GIT_INDEX_FILE: string }) => Promise<T>): Promise<T> {
    const directory = await mkdtemp(join(tmpdir(), "zli-checkpoint-"));
    try {
      return await work({ GIT_INDEX_FILE: join(directory, "index") });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async changes(
    cwd: string,
    from: string,
    to: string,
  ): Promise<{ files: TurnCheckpointFile[]; fileCount: number; additions: number; deletions: number }> {
    const args = ["diff-tree", "-r", "-z", "--find-renames"];
    const [names, stats] = await Promise.all([
      this.git.run([...args, "--name-status", from, to], { cwd }),
      this.git.run([...args, "--numstat", from, to], { cwd }),
    ]);
    const entries = parseNameStatus(names.stdout);
    const byPath = new Map(parseNumstat(stats.stdout).map((entry) => [entry.path, entry]));
    let additions = 0;
    let deletions = 0;
    const files = entries.map((entry): TurnCheckpointFile => {
      const stat = byPath.get(entry.path);
      additions += stat?.additions ?? 0;
      deletions += stat?.deletions ?? 0;
      return {
        path: entry.path,
        ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
        kind: fileKind(entry.status),
        additions: stat?.additions ?? 0,
        deletions: stat?.deletions ?? 0,
        binary: stat?.binary ?? false,
      };
    });
    return { files: files.slice(0, MAX_CHECKPOINT_FILES), fileCount: files.length, additions, deletions };
  }

  private async readTrees<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (error) {
      if (error instanceof Error && /bad object|not a tree|unknown revision/iu.test(error.message)) {
        throw new CheckpointError("This turn's saved files are no longer in Git.");
      }
      throw error;
    }
  }

  private async dropRefs(threadIds: readonly string[]): Promise<void> {
    const projection = await this.engine.projection();
    for (const worktree of projection.worktrees) {
      if (worktree.status !== "ready") continue;
      for (const threadId of threadIds) {
        try {
          const listed = await this.git.run(["for-each-ref", "--format=%(refname)", `${REF_ROOT}/${threadId}/`], {
            cwd: worktree.path,
          });
          for (const ref of listed.stdout.split(/\r?\n/u).filter(Boolean)) {
            await this.git.run(["update-ref", "-d", ref], { cwd: worktree.path });
          }
        } catch {
          // The folder may be gone or no longer a Git checkout.
        }
      }
    }
  }

  private track(task: Promise<void>): void {
    this.tasks.add(task);
    void task.then(
      () => this.tasks.delete(task),
      () => this.tasks.delete(task),
    );
  }
}

/** Parses `git diff-tree --name-status -z`: `M\0path\0`, or `R100\0old\0new\0` for renames and copies. */
export function parseNameStatus(stdout: string): NameStatus[] {
  const fields = stdout.split("\0");
  const entries: NameStatus[] = [];
  let index = 0;
  while (index < fields.length) {
    const code = fields[index] ?? "";
    const status = code.charAt(0);
    if (!/^[ACDMRTUX]$/u.test(status)) {
      index += 1;
      continue;
    }
    if (status === "R" || status === "C") {
      const oldPath = fields[index + 1];
      const path = fields[index + 2];
      index += 3;
      if (oldPath && path) entries.push({ status, path, oldPath });
      continue;
    }
    const path = fields[index + 1];
    index += 2;
    if (path) entries.push({ status, path });
  }
  return entries;
}

function fileKind(status: string): TurnCheckpointFile["kind"] {
  if (status === "A" || status === "C") return "added";
  if (status === "D") return "deleted";
  if (status === "R") return "renamed";
  return "modified";
}

/** Matches the turn id the usage records use, so a turn is named the same everywhere. */
function boundedTurnId(turnId: string): string {
  return turnId.length <= MAX_TURN_ID ? turnId : createHash("sha256").update(turnId).digest("hex");
}

async function removeEmptyParents(root: string, path: string): Promise<void> {
  let directory = dirname(join(root, path));
  const top = resolve(root);
  while (resolve(directory) !== top && resolve(directory).startsWith(top)) {
    try {
      await rmdir(directory);
    } catch {
      return;
    }
    directory = dirname(directory);
  }
}
