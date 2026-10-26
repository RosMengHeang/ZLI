import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { assertChangePath, GitChangesError, GitChangesService, parseStashList } from "./GitChangesService.js";
import { parseStatusZ } from "./gitStatus.js";
import { splitPatch } from "./hunkPatch.js";
import { type ProcessResult, type ProcessRunner, runProcess } from "./PullRequestService.js";

type Call = { args: string[]; input?: string | undefined };
const ok = (stdout = ""): ProcessResult => ({ code: 0, stdout, stderr: "" });
const SHA = "a".repeat(40);

function fakeRunner(handle: (args: string[]) => ProcessResult | undefined = () => undefined) {
  const calls: Call[] = [];
  const runner: ProcessRunner = async (_command, args, options) => {
    calls.push({ args: [...args], input: options.input });
    return handle([...args]) ?? ok();
  };
  return { runner, calls };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runProcess("git", args, { cwd, timeoutMs: 30_000 });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

/** Windows runners default to core.autocrlf, which would check files out with CRLF and break the LF fixtures. */
async function keepLf(cwd: string): Promise<void> {
  await git(cwd, "config", "core.autocrlf", "false");
  await git(cwd, "config", "core.eol", "lf");
}

/** A repository with one committed file of ten numbered lines. */
async function repository(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "zli-changes-"));
  await git(cwd, "init", "--quiet");
  await keepLf(cwd);
  await git(cwd, "config", "user.email", "zli-changes@example.invalid");
  await git(cwd, "config", "user.name", "ZLI Changes");
  await git(cwd, "config", "commit.gpgsign", "false");
  await writeFile(join(cwd, "list.txt"), numbered(), "utf8");
  await git(cwd, "add", "list.txt");
  await git(cwd, "commit", "--quiet", "-m", "base");
  return cwd;
}

function numbered(edit: Record<number, string> = {}): string {
  return Array.from({ length: 20 }, (_, index) => edit[index + 1] ?? `line ${index + 1}`)
    .join("\n")
    .concat("\n");
}

/** Line 2 and line 19 changed, far enough apart for two hunks. */
const TWO_EDITS = numbered({ 2: "line two", 19: "line nineteen" });

async function hunksOf(cwd: string, cached: boolean): Promise<string[]> {
  const patch = await git(cwd, "diff", "--no-color", ...(cached ? ["--cached"] : []), "--", "list.txt");
  return splitPatch(patch)?.hunks.map((hunk) => hunk.join("\n")) ?? [];
}

describe("assertChangePath", () => {
  it("accepts worktree paths and refuses ones that escape it or read as options", () => {
    expect(() => assertChangePath("src/app file.ts")).not.toThrow();
    for (const path of ["", "-rf", "../x", "a/../../x", "/etc/passwd", "C:/x", "a\\b", "a\0b"]) {
      expect(() => assertChangePath(path)).toThrow(GitChangesError);
    }
  });
});

describe("GitChangesService with a fake runner", () => {
  it("stages and unstages with literal pathspecs after --", async () => {
    const { runner, calls } = fakeRunner();
    const service = new GitChangesService(runner);
    await service.stage("/repo", ["src/*.ts", ":(top)x"]);
    await service.stage("/repo");
    await service.unstage("/repo", ["a.ts"]);
    await service.unstage("/repo");
    expect(calls.map((call) => call.args)).toEqual([
      ["--literal-pathspecs", "add", "--all", "--", "src/*.ts", ":(top)x"],
      ["--literal-pathspecs", "add", "--all", "--", "."],
      ["--literal-pathspecs", "reset", "--quiet", "--", "a.ts"],
      ["--literal-pathspecs", "reset", "--quiet", "--", "."],
    ]);
  });

  it("refuses unsafe paths before running Git", async () => {
    const { runner, calls } = fakeRunner();
    const service = new GitChangesService(runner);
    await expect(service.stage("/repo", ["--all"])).rejects.toThrow("ZLI cannot change this path: --all");
    await expect(service.discard("/repo", "../outside")).rejects.toThrow(GitChangesError);
    expect(calls).toEqual([]);
  });

  it("deletes an untracked file and restores a renamed one under both names", async () => {
    const { runner, calls } = fakeRunner((args) =>
      args[0] === "status" ? ok("?? notes.txt\0R  new.ts\0old.ts\0 M kept.ts\0") : undefined,
    );
    const service = new GitChangesService(runner);
    await service.discard("/repo", "notes.txt");
    await service.discard("/repo", "new.ts");
    expect(calls.map((call) => call.args).filter((args) => args[0] !== "status")).toEqual([
      ["--literal-pathspecs", "clean", "--force", "-d", "--", "notes.txt"],
      ["--literal-pathspecs", "restore", "--source=HEAD", "--staged", "--worktree", "--", "new.ts", "old.ts"],
    ]);
  });

  it("says when a file has nothing to discard or is in conflict", async () => {
    const { runner } = fakeRunner((args) => (args[0] === "status" ? ok("UU merge.ts\0") : undefined));
    const service = new GitChangesService(runner);
    await expect(service.discard("/repo", "other.ts")).rejects.toThrow(
      "other.ts has no uncommitted changes to discard.",
    );
    await expect(service.discard("/repo", "merge.ts")).rejects.toThrow("merge.ts has a merge conflict");
  });

  it("refuses a hunk that no longer matches the diff", async () => {
    const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
    const { runner, calls } = fakeRunner((args) => (args.includes("diff") ? ok(patch) : undefined));
    const service = new GitChangesService(runner);
    await expect(
      service.hunk("/repo", { path: "a.ts", action: "stage", index: 0, hunk: "@@ -1 +1 @@\n-old\n+newer" }),
    ).rejects.toThrow("The diff of a.ts changed since it was shown.");
    await service.hunk("/repo", { path: "a.ts", action: "unstage", index: 0, hunk: "@@ -1 +1 @@\n-old\n+new" });
    expect(calls[1]?.args).toContain("--cached");
    expect(calls.at(-1)).toEqual({
      args: ["apply", "--cached", "--reverse", "--whitespace=nowarn", "-"],
      input: patch,
    });
  });

  it("checks the stash commit before dropping it, since indexes shift", async () => {
    const { runner, calls } = fakeRunner((args) => (args[0] === "rev-parse" ? ok(`${"b".repeat(40)}\n`) : undefined));
    const service = new GitChangesService(runner);
    await expect(service.stashAction("/repo", { action: "drop", index: 0, commit: SHA })).rejects.toThrow(
      "The stash list changed since it was shown.",
    );
    expect(calls.map((call) => call.args[0])).toEqual(["rev-parse"]);
  });
});

describe("status and stash parsing", () => {
  it("reads -z status records, including renames", () => {
    expect(parseStatusZ("R  new name.ts\0old.ts\0?? dir/\0 D gone.ts\0")).toEqual([
      { xy: "R ", path: "new name.ts", oldPath: "old.ts" },
      { xy: "??", path: "dir/" },
      { xy: " D", path: "gone.ts" },
    ]);
  });

  it("reads named and automatic stashes", () => {
    const sep = "\x1f";
    expect(
      parseStashList(
        [
          `stash@{0}${sep}${SHA}${sep}On feature/ui: try the layout${sep}2025-01-02T03:04:05+00:00`,
          `stash@{1}${sep}${"c".repeat(40)}${sep}WIP on main: 1a2b3c4 Add the button${sep}`,
          `stash@{2}${sep}${"d".repeat(40)}${sep}WIP on (no branch): 1a2b3c4 Detached${sep}`,
          "garbage",
        ].join("\n"),
      ),
    ).toEqual([
      {
        index: 0,
        commit: SHA,
        branch: "feature/ui",
        message: "try the layout",
        createdAt: "2025-01-02T03:04:05+00:00",
      },
      { index: 1, commit: "c".repeat(40), branch: "main", message: "Work in progress: Add the button" },
      { index: 2, commit: "d".repeat(40), message: "Work in progress: Detached" },
    ]);
  });
});

// Each case runs a handful of real git processes, which can exceed the default timeout on slow runners.
describe("GitChangesService with real Git", { timeout: 30_000 }, () => {
  it("stages, unstages, and discards single hunks", async () => {
    const cwd = await repository();
    try {
      await writeFile(join(cwd, "list.txt"), TWO_EDITS, "utf8");
      const service = new GitChangesService();
      const unstaged = await hunksOf(cwd, false);
      expect(unstaged).toHaveLength(2);

      await service.hunk(cwd, { path: "list.txt", action: "stage", index: 1, hunk: unstaged[1] ?? "" });
      const staged = await hunksOf(cwd, true);
      expect(staged).toHaveLength(1);
      expect(staged[0]).toContain("+line nineteen");
      expect(await hunksOf(cwd, false)).toEqual([expect.stringContaining("+line two")]);

      await service.hunk(cwd, { path: "list.txt", action: "unstage", index: 0, hunk: staged[0] ?? "" });
      expect(await hunksOf(cwd, true)).toEqual([]);

      const again = await hunksOf(cwd, false);
      await service.hunk(cwd, { path: "list.txt", action: "discard", index: 0, hunk: again[0] ?? "" });
      expect(await readFile(join(cwd, "list.txt"), "utf8")).toBe(numbered({ 19: "line nineteen" }));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("stages a hunk at the end of a file without a final newline", async () => {
    const cwd = await repository();
    try {
      await writeFile(join(cwd, "list.txt"), numbered({ 20: "last" }).replace(/\n$/u, ""), "utf8");
      const service = new GitChangesService();
      const [hunk] = await hunksOf(cwd, false);
      expect(hunk).toContain("\\ No newline at end of file");
      await service.hunk(cwd, { path: "list.txt", action: "stage", index: 0, hunk: hunk ?? "" });
      expect(await git(cwd, "status", "--porcelain=v1")).toBe("M  list.txt\n");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("stages, unstages, and discards whole files, untracked ones included", async () => {
    const cwd = await repository();
    try {
      const service = new GitChangesService();
      await writeFile(join(cwd, "list.txt"), TWO_EDITS, "utf8");
      await writeFile(join(cwd, "new file.txt"), "fresh\n", "utf8");
      await service.stage(cwd, ["new file.txt"]);
      expect(await git(cwd, "status", "--porcelain=v1")).toBe(' M list.txt\nA  "new file.txt"\n');
      await service.stage(cwd);
      expect(await git(cwd, "status", "--porcelain=v1")).toBe('M  list.txt\nA  "new file.txt"\n');
      await service.unstage(cwd, ["list.txt"]);
      expect(await git(cwd, "status", "--porcelain=v1")).toBe(' M list.txt\nA  "new file.txt"\n');
      await service.unstage(cwd);
      expect(await git(cwd, "status", "--porcelain=v1")).toBe(' M list.txt\n?? "new file.txt"\n');

      await service.discard(cwd, "new file.txt");
      await service.discard(cwd, "list.txt");
      expect(await git(cwd, "status", "--porcelain=v1")).toBe("");
      expect(await readFile(join(cwd, "list.txt"), "utf8")).toBe(numbered());
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("unstages before the first commit", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "zli-changes-unborn-"));
    try {
      await git(cwd, "init", "--quiet");
      await keepLf(cwd);
      await writeFile(join(cwd, "a.txt"), "a\n", "utf8");
      const service = new GitChangesService();
      await service.stage(cwd);
      expect(await git(cwd, "status", "--porcelain=v1")).toBe("A  a.txt\n");
      await service.unstage(cwd);
      expect(await git(cwd, "status", "--porcelain=v1")).toBe("?? a.txt\n");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("stashes with untracked files, then applies, pops, and drops", async () => {
    const cwd = await repository();
    try {
      const service = new GitChangesService();
      expect(await service.stash(cwd)).toEqual({ stashes: [], created: false });

      await writeFile(join(cwd, "list.txt"), TWO_EDITS, "utf8");
      await writeFile(join(cwd, "scratch.txt"), "scratch\n", "utf8");
      const stashed = await service.stash(cwd, "  try\nthis  ");
      expect(stashed.created).toBe(true);
      expect(stashed.stashes).toEqual([expect.objectContaining({ index: 0, message: "try this" })]);
      expect(await git(cwd, "status", "--porcelain=v1")).toBe("");

      const first = stashed.stashes[0];
      if (!first) throw new Error("expected a stash");
      const applied = await service.stashAction(cwd, { action: "apply", index: 0, commit: first.commit });
      expect(applied.stashes).toHaveLength(1);
      expect(await git(cwd, "status", "--porcelain=v1")).toBe(" M list.txt\n?? scratch.txt\n");

      await git(cwd, "checkout", "--", "list.txt");
      await rm(join(cwd, "scratch.txt"));
      const popped = await service.stashAction(cwd, { action: "pop", index: 0, commit: first.commit });
      expect(popped.stashes).toEqual([]);
      expect(await readFile(join(cwd, "scratch.txt"), "utf8")).toBe("scratch\n");

      const second = (await service.stash(cwd)).stashes[0];
      if (!second) throw new Error("expected a stash");
      expect(second.message).toMatch(/^Work in progress: /u);
      expect(await service.stashAction(cwd, { action: "drop", index: 0, commit: second.commit })).toEqual({
        stashes: [],
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("reports conflicts when a stash does not apply cleanly and keeps a popped stash", async () => {
    const cwd = await repository();
    try {
      const service = new GitChangesService();
      await writeFile(join(cwd, "list.txt"), numbered({ 2: "from the stash" }), "utf8");
      const [stash] = (await service.stash(cwd)).stashes;
      if (!stash) throw new Error("expected a stash");
      await writeFile(join(cwd, "list.txt"), numbered({ 2: "committed meanwhile" }), "utf8");
      await git(cwd, "commit", "--quiet", "-am", "meanwhile");

      const result = await service.stashAction(cwd, { action: "pop", index: 0, commit: stash.commit });
      expect(result.conflicted).toBe(true);
      expect(result.stashes).toHaveLength(1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
