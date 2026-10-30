import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { ProjectId, type RuntimeProjection, WorktreeId } from "@zli-v2/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  branchChanges,
  nativeGitPath,
  type ProcessResult,
  type ProcessRunner,
  PullRequestError,
  PullRequestService,
  parseUpstream,
  runProcess,
  runPullRequestCommand,
} from "./PullRequestService.js";

type Call = { command: Parameters<ProcessRunner>[0]; args: string[] };
type Handler = (line: string, args: string[]) => ProcessResult | undefined;

const ok = (stdout = ""): ProcessResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string, code = 1): ProcessResult => ({ code, stdout: "", stderr });
const INPUT = { worktreePath: "/repo/feature", fallbackBase: "main" };
const LOCAL = new Set(["feature", "main", "done", "other"]);
const ORIGIN = new Set(["main", "release"]);

/** Branch feature checked out; main, done, and other exist locally; other is checked out at /repo/other. */
function fakeRunner(overrides: Handler = () => undefined): { runner: ProcessRunner; calls: Call[] } {
  const calls: Call[] = [];
  const runner: ProcessRunner = async (command, args) => {
    calls.push({ command, args: [...args] });
    const line = `${command} ${args.join(" ")}`;
    const override = overrides(line, [...args]);
    if (override) return override;
    if (line === "git rev-parse --abbrev-ref HEAD") return ok("feature\n");
    if (line.startsWith("git symbolic-ref")) return ok("origin/main\n");
    if (line === "git remote get-url origin") return ok("https://example.com/acme/app.git\n");
    if (line.startsWith("git show-ref --verify --quiet refs/heads/")) {
      return LOCAL.has(line.slice("git show-ref --verify --quiet refs/heads/".length)) ? ok() : fail("", 1);
    }
    if (line.startsWith("git show-ref --verify --quiet refs/remotes/origin/")) {
      return ORIGIN.has(line.slice("git show-ref --verify --quiet refs/remotes/origin/".length)) ? ok() : fail("", 1);
    }
    if (line.startsWith("git check-ref-format --branch ")) return ok(`${args.at(-1)}\n`);
    if (line.startsWith("git rev-parse --verify --quiet")) return ok("abc\n");
    if (args[0] === "for-each-ref") {
      return ok(
        [
          "refs/heads/feature\0origin/feature\0ahead 1\0/repo/feature",
          "refs/heads/main\0origin/main\0behind 2\0",
          "refs/heads/other\0\0\0/repo/other",
          "refs/remotes/origin/main\0\0\0",
        ].join("\n"),
      );
    }
    if (["switch", "branch", "push"].includes(args[0] ?? "")) return ok();
    return fail(`unexpected: ${line}`, 2);
  };
  return { runner, calls };
}

const lines = (calls: Call[]) => calls.map((call) => call.args.join(" "));

describe("PullRequestService.createBranch", () => {
  it("creates and checks out a branch that tracks nothing, from the picked start", async () => {
    const { runner, calls } = fakeRunner();
    const result = await new PullRequestService(runner).createBranch(INPUT, {
      name: "topic",
      from: "origin/main",
      switchTo: true,
    });
    expect(lines(calls)).toContain("check-ref-format --branch topic");
    expect(lines(calls)).toContain("rev-parse --verify --quiet origin/main^{commit}");
    expect(lines(calls)).toContain("switch --no-track -c topic origin/main");
    expect(result.local).toContain("feature");
  });

  it("creates a branch at HEAD without switching", async () => {
    const { runner, calls } = fakeRunner();
    await new PullRequestService(runner).createBranch(INPUT, { name: "topic", switchTo: false });
    expect(lines(calls)).toContain("branch --no-track topic");
    expect(lines(calls).some((line) => line.startsWith("switch"))).toBe(false);
  });

  it("rejects names Git would not keep, names that look like origin's, and existing branches", async () => {
    const service = new PullRequestService(fakeRunner().runner);
    await expect(service.createBranch(INPUT, { name: "  ", switchTo: false })).rejects.toThrow("Enter a branch name.");
    await expect(service.createBranch(INPUT, { name: "-x", switchTo: false })).rejects.toThrow(
      /not a valid branch name/u,
    );
    await expect(service.createBranch(INPUT, { name: "origin/main", switchTo: false })).rejects.toThrow(
      /confused with a branch on origin/u,
    );
    await expect(service.createBranch(INPUT, { name: "main", switchTo: false })).rejects.toThrow(
      "A branch named main already exists. Pick another name or switch to it.",
    );
    const shorthand = new PullRequestService(
      fakeRunner((line) => (line.startsWith("git check-ref-format") ? ok("main\n") : undefined)).runner,
    );
    await expect(shorthand.createBranch(INPUT, { name: "@{-1}", switchTo: false })).rejects.toThrow(
      /not a valid branch name/u,
    );
    const invalid = new PullRequestService(
      fakeRunner((line) => (line.startsWith("git check-ref-format") ? fail("fatal: bad name") : undefined)).runner,
    );
    await expect(invalid.createBranch(INPUT, { name: "has space", switchTo: false })).rejects.toBeInstanceOf(
      PullRequestError,
    );
  });

  it("explains a start point that does not exist", async () => {
    const { runner } = fakeRunner((line) => (line.startsWith("git rev-parse --verify") ? fail("", 1) : undefined));
    await expect(
      new PullRequestService(runner).createBranch(INPUT, { name: "topic", from: "nope", switchTo: true }),
    ).rejects.toThrow("There is no branch or commit named nope.");
  });
});

describe("PullRequestService.switchBranch", () => {
  it("checks out a local branch", async () => {
    const { runner, calls } = fakeRunner();
    await new PullRequestService(runner).switchBranch(INPUT, "main");
    expect(lines(calls)).toContain("switch main");
  });

  it("creates a tracking branch for a branch only on origin", async () => {
    const { runner, calls } = fakeRunner();
    await new PullRequestService(runner).switchBranch(INPUT, "origin/release");
    expect(lines(calls)).toContain("switch -c release --track origin/release");
  });

  it("uses the local branch when origin's branch already has one", async () => {
    const { runner, calls } = fakeRunner();
    await new PullRequestService(runner).switchBranch(INPUT, "origin/main");
    expect(lines(calls)).toContain("switch main");
  });

  it("does nothing for the branch already checked out", async () => {
    const { runner, calls } = fakeRunner();
    await new PullRequestService(runner).switchBranch(INPUT, "feature");
    expect(lines(calls).some((line) => line.startsWith("switch"))).toBe(false);
  });

  it("explains a branch that does not exist", async () => {
    const service = new PullRequestService(fakeRunner().runner);
    await expect(service.switchBranch(INPUT, "missing")).rejects.toThrow("There is no branch named missing.");
    await expect(service.switchBranch(INPUT, "origin/missing")).rejects.toThrow(
      "There is no branch named origin/missing.",
    );
  });

  it("explains uncommitted changes that would be overwritten, naming the files", async () => {
    const { runner } = fakeRunner((line) =>
      line === "git switch main"
        ? fail(
            "error: Your local changes to the following files would be overwritten by checkout:\n\tsrc/a.ts\n\tsrc/b.ts\nPlease commit your changes or stash them before you switch branches.\nAborting\n",
          )
        : undefined,
    );
    await expect(new PullRequestService(runner).switchBranch(INPUT, "main")).rejects.toThrow(
      "Switching to main would overwrite uncommitted changes in src/a.ts, src/b.ts. Commit or stash them, then switch again.",
    );
  });

  it("explains a branch checked out in another worktree, in old and new Git wording", async () => {
    for (const stderr of [
      "fatal: 'main' is already checked out at '/repo/main'",
      "fatal: 'main' is already used by worktree at '/repo/main'",
    ]) {
      const { runner } = fakeRunner((line) => (line === "git switch main" ? fail(stderr) : undefined));
      await expect(new PullRequestService(runner).switchBranch(INPUT, "main")).rejects.toThrow(
        /^main is checked out in another worktree at \/repo\/main\./u,
      );
    }
  });

  it("names a Windows worktree the way Windows writes paths", async () => {
    const { runner } = fakeRunner((line) =>
      line === "git switch main" ? fail("fatal: 'main' is already used by worktree at 'C:/work/main'") : undefined,
    );
    await expect(new PullRequestService(runner).switchBranch(INPUT, "main")).rejects.toThrow(
      /^main is checked out in another worktree at C:\\work\\main\./u,
    );
    expect(nativeGitPath("C:/work/main")).toBe("C:\\work\\main");
    expect(nativeGitPath("/repo/main")).toBe("/repo/main");
  });

  it("explains unresolved conflicts", async () => {
    const { runner } = fakeRunner((line) =>
      line === "git switch main" ? fail("error: you need to resolve your current index first") : undefined,
    );
    await expect(new PullRequestService(runner).switchBranch(INPUT, "main")).rejects.toThrow(
      /unresolved merge conflicts/u,
    );
  });
});

describe("PullRequestService.renameBranch", () => {
  it("renames a local branch", async () => {
    const { runner, calls } = fakeRunner();
    await new PullRequestService(runner).renameBranch(INPUT, { from: "feature", to: "feature-2" });
    expect(lines(calls)).toContain("branch -m feature feature-2");
  });

  it("refuses a taken name, a missing branch, and a branch checked out elsewhere", async () => {
    const service = new PullRequestService(fakeRunner().runner);
    await expect(service.renameBranch(INPUT, { from: "feature", to: "main" })).rejects.toThrow(
      "A branch named main already exists.",
    );
    await expect(service.renameBranch(INPUT, { from: "missing", to: "x" })).rejects.toThrow(
      "There is no local branch named missing.",
    );
    await expect(service.renameBranch(INPUT, { from: "other", to: "other-2" })).rejects.toThrow(
      "other is checked out in another worktree at /repo/other. Rename it from that worktree instead.",
    );
  });
});

describe("PullRequestService.deleteBranch", () => {
  it("deletes a merged local branch and, when asked, its copy on origin", async () => {
    const { runner, calls } = fakeRunner();
    await new PullRequestService(runner).deleteBranch(INPUT, { name: "done", force: false, remote: true });
    expect(lines(calls)).toContain("branch -d done");
    expect(lines(calls)).toContain("push origin --delete done");
  });

  it("force deletes with -D and leaves origin alone by default", async () => {
    const { runner, calls } = fakeRunner();
    await new PullRequestService(runner).deleteBranch(INPUT, { name: "done", force: true, remote: false });
    expect(lines(calls)).toContain("branch -D done");
    expect(lines(calls).some((line) => line.startsWith("push"))).toBe(false);
  });

  it("never deletes the checked-out branch", async () => {
    const { runner, calls } = fakeRunner();
    await expect(
      new PullRequestService(runner).deleteBranch(INPUT, { name: "feature", force: true, remote: true }),
    ).rejects.toThrow("feature is checked out in this worktree. Switch to another branch, then delete it.");
    expect(lines(calls).some((line) => line.startsWith("branch -") || line.startsWith("push"))).toBe(false);
  });

  it("explains unmerged commits and a branch used by another worktree", async () => {
    const unmerged = fakeRunner((line) =>
      line === "git branch -d done" ? fail("error: The branch 'done' is not fully merged.") : undefined,
    ).runner;
    await expect(
      new PullRequestService(unmerged).deleteBranch(INPUT, { name: "done", force: false, remote: true }),
    ).rejects.toThrow(
      "done has commits that are not merged into feature or its upstream. Turn on Delete unmerged commits to delete it anyway.",
    );
    const elsewhere = fakeRunner((line) =>
      line === "git branch -d other"
        ? fail("error: cannot delete branch 'other' used by worktree at '/repo/other'")
        : undefined,
    ).runner;
    await expect(
      new PullRequestService(elsewhere).deleteBranch(INPUT, { name: "other", force: false, remote: false }),
    ).rejects.toThrow(/^other is checked out in another worktree at \/repo\/other\./u);
  });

  it("deletes a branch that only origin has, and counts one origin already removed", async () => {
    const { runner, calls } = fakeRunner((line) =>
      line === "git push origin --delete release"
        ? fail("error: unable to delete 'release': remote ref does not exist")
        : undefined,
    );
    await new PullRequestService(runner).deleteBranch(INPUT, { name: "release", force: false, remote: true });
    expect(lines(calls).some((line) => line.startsWith("branch -"))).toBe(false);
    await expect(
      new PullRequestService(runner).deleteBranch(INPUT, { name: "release", force: false, remote: false }),
    ).rejects.toThrow("There is no local branch named release.");
  });

  it("says the local branch is gone when origin refuses, without echoing credentials", async () => {
    const { runner } = fakeRunner((line) =>
      line.startsWith("git push")
        ? fail("fatal: Authentication failed for 'https://user:secret@example.com/'")
        : undefined,
    );
    const error = await new PullRequestService(runner)
      .deleteBranch(INPUT, { name: "done", force: false, remote: true })
      .catch((cause: unknown) => cause);
    expect(String(error)).toMatch(/^PullRequestError: Deleted done on this computer\. origin refused the credentials/u);
    expect(String(error)).not.toContain("secret");
  });

  it("asks for origin before deleting anything", async () => {
    const { runner, calls } = fakeRunner((line) =>
      line === "git remote get-url origin" ? fail("error: No such remote 'origin'", 2) : undefined,
    );
    await expect(
      new PullRequestService(runner).deleteBranch(INPUT, { name: "done", force: false, remote: true }),
    ).rejects.toThrow(/no origin remote/u);
    expect(lines(calls)).not.toContain("branch -d done");
  });
});

describe("parseUpstream", () => {
  it("reads ahead, behind, in sync, and gone", () => {
    expect(parseUpstream("origin/a", "ahead 2, behind 1")).toEqual({ name: "origin/a", ahead: 2, behind: 1 });
    expect(parseUpstream("origin/a", "behind 4")).toEqual({ name: "origin/a", ahead: 0, behind: 4 });
    expect(parseUpstream("origin/a", "")).toEqual({ name: "origin/a", ahead: 0, behind: 0 });
    expect(parseUpstream("origin/a", "gone")).toEqual({ name: "origin/a", ahead: 0, behind: 0, gone: true });
    expect(parseUpstream("", "")).toBeUndefined();
  });
});

const projectId = ProjectId.parse("00000000-0000-4000-8000-000000000010");
const here = WorktreeId.parse("00000000-0000-4000-8000-000000000101");
const there = WorktreeId.parse("00000000-0000-4000-8000-000000000102");

function projection(branchHere: string, branchThere: string): RuntimeProjection {
  return {
    projects: [{ projectId, path: "/repo", name: "repo" }],
    worktrees: [
      { worktreeId: here, projectId, path: "/repo/feature", branch: branchHere, status: "ready" },
      { worktreeId: there, projectId, path: "/repo/other/", branch: branchThere, status: "ready" },
    ],
  } as unknown as RuntimeProjection;
}

describe("branchChanges", () => {
  it("reports the new current branch and branches Git sees checked out in other worktrees", () => {
    const state = projection("old-name", "stale");
    const worktree = state.worktrees[0];
    if (!worktree) throw new Error("missing worktree");
    expect(
      branchChanges(state, worktree, {
        current: "feature",
        local: ["feature", "other"],
        remote: [],
        details: { other: { worktreePath: "/repo/other" } },
      }),
    ).toEqual([
      { worktreeId: here, branch: "feature" },
      { worktreeId: there, branch: "other" },
    ]);
  });

  it("reports nothing when the projection already matches or HEAD is detached", () => {
    const state = projection("feature", "other");
    const worktree = state.worktrees[0];
    if (!worktree) throw new Error("missing worktree");
    expect(branchChanges(state, worktree, { local: [], remote: [] })).toEqual([]);
    expect(
      branchChanges(state, worktree, {
        current: "feature",
        local: [],
        remote: [],
        details: { other: { worktreePath: "/repo/other" } },
      }),
    ).toEqual([]);
  });

  it("is given every branch list a branch command answers with", async () => {
    const seen: string[] = [];
    const state = projection("feature", "other");
    await runPullRequestCommand(
      new PullRequestService(fakeRunner().runner),
      state,
      { type: "review.git.switchBranch", worktreeId: here, name: "main" },
      async (_worktree, result) => void seen.push(result.current ?? ""),
    );
    await runPullRequestCommand(
      new PullRequestService(fakeRunner().runner),
      state,
      { type: "review.git.pull", worktreeId: here },
      async () => void seen.push("pull"),
    ).catch(() => undefined);
    expect(seen).toEqual(["feature"]);
  });
});

describe("branch commands against a real repository", () => {
  const roots: string[] = [];
  const execFileAsync = promisify(execFile);
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function repository() {
    const root = await realpath(await mkdtemp(join(tmpdir(), "zli-v2-branches-")));
    roots.push(root);
    const git = (...args: string[]) => execFileAsync("git", args, { cwd: root });
    await git("init", "-b", "main");
    await git("config", "user.email", "zli-tests@example.invalid");
    await git("config", "user.name", "ZLI Tests");
    await writeFile(join(root, "README.md"), "initial\n");
    await git("add", "README.md");
    await git("commit", "-m", "initial");
    return { root, git, input: { worktreePath: root, fallbackBase: "main" } };
  }

  it("creates, switches, renames, and deletes branches", async () => {
    const { root, git, input } = await repository();
    const service = new PullRequestService(runProcess);

    await expect(service.createBranch(input, { name: "a..b", switchTo: true })).rejects.toThrow(
      /a\.\.b is not a valid branch name/u,
    );
    let result = await service.createBranch(input, { name: "topic", switchTo: true });
    expect(result.current).toBe("topic");
    await writeFile(join(root, "topic.txt"), "topic\n");
    await git("add", "topic.txt");
    await git("commit", "-m", "topic work");

    result = await service.switchBranch(input, "main");
    expect(result.current).toBe("main");

    result = await service.renameBranch(input, { from: "topic", to: "topic-renamed" });
    expect(result.local).toContain("topic-renamed");
    expect(result.local).not.toContain("topic");

    await expect(service.deleteBranch(input, { name: "topic-renamed", force: false, remote: false })).rejects.toThrow(
      /not merged into main/u,
    );
    await expect(service.deleteBranch(input, { name: "main", force: true, remote: false })).rejects.toThrow(
      /checked out in this worktree/u,
    );
    result = await service.deleteBranch(input, { name: "topic-renamed", force: true, remote: false });
    expect(result.local).toEqual(["main"]);
  });

  it("refuses to switch over uncommitted changes and names a branch held by another worktree", async () => {
    const { root, git, input } = await repository();
    const service = new PullRequestService(runProcess);
    await git("branch", "other");
    await git("switch", "other");
    await writeFile(join(root, "README.md"), "changed on other\n");
    await git("commit", "-am", "other change");
    await git("switch", "main");
    await writeFile(join(root, "README.md"), "uncommitted\n");
    await expect(service.switchBranch(input, "other")).rejects.toThrow(
      "Switching to other would overwrite uncommitted changes in README.md. Commit or stash them, then switch again.",
    );
    await git("checkout", "--", "README.md");

    const second = join(root, "..", `${root.split(/[\\/]/u).at(-1)}-second`);
    roots.push(second);
    await git("worktree", "add", second, "other");
    const listed = await service.branches(input);
    expect(listed.details?.other?.worktreePath).toBe(second);
    await expect(service.switchBranch(input, "other")).rejects.toThrow(
      `other is checked out in another worktree at ${second}.`,
    );
    await expect(service.deleteBranch(input, { name: "other", force: true, remote: false })).rejects.toThrow(
      `other is checked out in another worktree at ${second}.`,
    );
  });
});
