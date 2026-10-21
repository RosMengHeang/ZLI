import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { copyIntoWorktree } from "./WorktreeCopy.js";
import { readZliConfig, setupCommandsHash } from "./zliConfig.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function folders() {
  const root = await mkdtemp(join(tmpdir(), "zli-copy-"));
  roots.push(root);
  const repoPath = join(root, "repo");
  const worktreePath = join(root, "worktree");
  await mkdir(repoPath);
  await mkdir(worktreePath);
  return { root, repoPath, worktreePath };
}

describe("setup command hash", () => {
  it("is stable for the same list and changes with order or content", () => {
    expect(setupCommandsHash(["pnpm install"])).toBe(setupCommandsHash(["pnpm install"]));
    expect(setupCommandsHash(["a", "b"])).not.toBe(setupCommandsHash(["b", "a"]));
    expect(setupCommandsHash(["a b"])).not.toBe(setupCommandsHash(["a", "b"]));
  });
});

describe("readZliConfig", () => {
  it("reports a missing, valid, and invalid file", async () => {
    const { repoPath } = await folders();
    await expect(readZliConfig(repoPath)).resolves.toEqual({ status: "missing" });

    await writeFile(join(repoPath, "zli.json"), JSON.stringify({ version: 1, worktree: { setup: ["make"] } }));
    await expect(readZliConfig(repoPath)).resolves.toEqual({
      status: "valid",
      config: { version: 1, worktree: { setup: ["make"] } },
      commandsHash: setupCommandsHash(["make"]),
    });

    await writeFile(join(repoPath, "zli.json"), "{");
    const invalid = await readZliConfig(repoPath);
    expect(invalid.status).toBe("invalid");
  });
});

describe("copyIntoWorktree", () => {
  it("copies literal paths and glob matches without overwriting", async () => {
    const { repoPath, worktreePath } = await folders();
    await writeFile(join(repoPath, ".env"), "KEY=main\n");
    await mkdir(join(repoPath, "config"));
    await writeFile(join(repoPath, "config", "a.local.json"), "{}");
    await writeFile(join(repoPath, "config", "b.local.json"), "{}");
    await writeFile(join(repoPath, "config", "shared.json"), "{}");
    await writeFile(join(repoPath, "kept.txt"), "main\n");
    await writeFile(join(worktreePath, "kept.txt"), "worktree\n");

    const report = await copyIntoWorktree({
      repoPath,
      worktreePath,
      patterns: [".env", "config/*.local.json", "kept.txt", "missing.txt", "nothing/*.txt"],
    });

    expect(report.copied).toEqual([".env", "config/a.local.json", "config/b.local.json"]);
    expect(report.skipped).toEqual([
      { entry: "kept.txt", reason: "It already exists in the worktree." },
      { entry: "missing.txt", reason: "It does not exist in the main checkout." },
      { entry: "nothing/*.txt", reason: "Nothing matches it." },
    ]);
    await expect(readFile(join(worktreePath, ".env"), "utf8")).resolves.toBe("KEY=main\n");
    await expect(readFile(join(worktreePath, "kept.txt"), "utf8")).resolves.toBe("worktree\n");
  });

  it("never follows symlinks out of the repository or the worktree", async () => {
    const { root, repoPath, worktreePath } = await folders();
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "secret.txt"), "secret\n");
    await symlink(join(outside, "secret.txt"), join(repoPath, "link.txt"));
    await symlink(outside, join(repoPath, "linked"));
    await mkdir(join(repoPath, "data"));
    await writeFile(join(repoPath, "data", "file.txt"), "data\n");
    await symlink(outside, join(worktreePath, "data"));

    const report = await copyIntoWorktree({
      repoPath,
      worktreePath,
      patterns: ["link.txt", "linked/secret.txt", "data/file.txt", "../outside/secret.txt"],
    });

    expect(report.copied).toEqual([]);
    expect(report.skipped.map((entry) => entry.entry)).toEqual([
      "link.txt",
      "linked/secret.txt",
      "data/file.txt",
      "../outside/secret.txt",
    ]);
    await expect(readFile(join(outside, "file.txt"), "utf8")).rejects.toThrow();
  });

  it("skips symlinks inside a copied folder and keeps globs out of node_modules", async () => {
    const { root, repoPath, worktreePath } = await folders();
    await writeFile(join(root, "outside.txt"), "outside\n");
    await mkdir(join(repoPath, "secrets"));
    await writeFile(join(repoPath, "secrets", "key.pem"), "key\n");
    await symlink(join(root, "outside.txt"), join(repoPath, "secrets", "escape.txt"));
    await mkdir(join(repoPath, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(repoPath, "node_modules", "pkg", ".env"), "vendored\n");
    await mkdir(join(repoPath, "apps", "web"), { recursive: true });
    await writeFile(join(repoPath, "apps", "web", ".env"), "web\n");

    const report = await copyIntoWorktree({ repoPath, worktreePath, patterns: ["secrets", "**/.env"] });

    expect(report.copied).toEqual(["secrets", "apps/web/.env"]);
    await expect(readFile(join(worktreePath, "secrets", "key.pem"), "utf8")).resolves.toBe("key\n");
    await expect(readFile(join(worktreePath, "secrets", "escape.txt"), "utf8")).rejects.toThrow();
  });
});
