import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import type { GitProcess } from "../git/GitProcess.js";
import { applyWorktreeInclude } from "./WorktreeInclude.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe(".worktreeinclude", () => {
  it("copies only literal existing ignored paths and reports every skip reason", async () => {
    const root = await mkdtemp(join(tmpdir(), "zli-include-"));
    roots.push(root);
    const repoPath = join(root, "repo");
    const worktreePath = join(root, "worktree");
    await mkdir(repoPath);
    await mkdir(worktreePath);
    await writeFile(join(repoPath, ".worktreeinclude"), [
      "ignored.env",
      "tracked.txt",
      "missing.txt",
      "config/*.json",
      "../outside.txt",
      "!negated.txt",
    ].join("\n"));
    await writeFile(join(repoPath, "ignored.env"), "secret=local\n");
    await writeFile(join(repoPath, "tracked.txt"), "tracked\n");

    const git = {
      run: async (args: readonly string[]) => {
        const entry = args.at(-1);
        if (args[0] === "ls-files") {
          if (entry === "tracked.txt") return { code: 0, stdout: "", stderr: "" };
          throw new Error("not tracked");
        }
        if (entry === "ignored.env") return { code: 0, stdout: "", stderr: "" };
        throw new Error("not ignored");
      },
    } as Pick<GitProcess, "run">;

    const report = await applyWorktreeInclude({ repoPath, worktreePath, git });

    await expect(readFile(join(worktreePath, "ignored.env"), "utf8")).resolves.toBe("secret=local\n");
    expect(report.copied).toEqual(["ignored.env"]);
    expect(report.skipped).toEqual([
      { entry: "tracked.txt", reason: "tracked" },
      { entry: "missing.txt", reason: "missing" },
      { entry: "config/*.json", reason: "glob" },
      { entry: "../outside.txt", reason: "traversal" },
      { entry: "!negated.txt", reason: "negation" },
    ]);
  });

  it("does not overwrite an existing target", async () => {
    const root = await mkdtemp(join(tmpdir(), "zli-include-target-"));
    roots.push(root);
    const repoPath = join(root, "repo");
    const worktreePath = join(root, "worktree");
    await mkdir(repoPath);
    await mkdir(worktreePath);
    await writeFile(join(repoPath, ".worktreeinclude"), "ignored.env\n");
    await writeFile(join(repoPath, "ignored.env"), "source\n");
    await writeFile(join(worktreePath, "ignored.env"), "user\n");
    const git = {
      run: async (args: readonly string[]) => {
        if (args[0] === "ls-files") throw new Error("not tracked");
        return { code: 0, stdout: "", stderr: "" };
      },
    } as Pick<GitProcess, "run">;

    const report = await applyWorktreeInclude({ repoPath, worktreePath, git });

    expect(report.skipped).toEqual([{ entry: "ignored.env", reason: "target_exists" }]);
    await expect(readFile(join(worktreePath, "ignored.env"), "utf8")).resolves.toBe("user\n");
  });
});
