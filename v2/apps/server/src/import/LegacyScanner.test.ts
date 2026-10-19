import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LegacyScanner } from "./LegacyScanner.js";

describe("LegacyScanner", () => {
  it("creates a preview without reading session contents or changing source data", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zli-legacy-scan-"));
    const repository = join(directory, "repo");
    const worktree = join(directory, "worktree");
    await mkdir(repository);
    await mkdir(worktree);
    const snapshot = join(directory, "legacy.json");
    const original = JSON.stringify({
      workspaceRegistry: {
        workspaces: [
          {
            root: repository,
            project: { name: "Tax project", path: repository, repositoryRoot: repository },
            agents: [
              { name: "Codex", provider: "codex", resumeId: "resume-1", worktreePath: worktree, branch: "feature/tax" },
              { name: "Claude", provider: "claude-code", resumeAvailability: "unsupported" },
            ],
          },
        ],
      },
    });
    await writeFile(snapshot, original, "utf8");

    try {
      const result = await new LegacyScanner().scan(snapshot, "batch-1");
      expect(result.preview.projects[0]?.state).toBe("ready");
      expect(result.preview.worktrees[0]?.state).toBe("ready");
      expect(result.preview.sessions.map((session) => session.resume)).toEqual(["exact", "unsupported"]);
      expect(await import("node:fs/promises").then((fs) => fs.readFile(snapshot, "utf8"))).toBe(original);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports duplicates, missing paths, moved paths, and corrupt snapshots", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zli-legacy-scan-"));
    const repository = join(directory, "repo");
    const movedRepository = join(directory, "moved-repo");
    const movedCwd = join(directory, "moved-cwd");
    await mkdir(repository);
    await mkdir(movedRepository);
    await mkdir(movedCwd);
    const scanner = new LegacyScanner();
    try {
      const preview = await scanner.scanValue(
        {
          workspaces: [
            { root: repository, project: { path: repository, name: "one" } },
            { root: repository, project: { path: repository, name: "duplicate" } },
            {
              root: repository,
              project: { path: join(directory, "missing") },
              agents: [{ name: "Missing", provider: "codex", worktreePath: join(directory, "missing-tree") }],
            },
            {
              root: movedRepository,
              project: { path: join(directory, "old-location") },
              agents: [{ name: "Moved", provider: "codex", cwd: movedCwd, worktreePath: join(directory, "old-tree") }],
            },
          ],
        },
        join(directory, "snapshot.json"),
        "batch-2",
      );
      expect(preview.conflicts.length).toBeGreaterThan(0);
      expect(preview.projects.some((project) => project.state === "duplicate")).toBe(true);
      expect(preview.projects.some((project) => project.state === "moved")).toBe(true);
      expect(preview.worktrees.some((worktree) => worktree.state === "missing")).toBe(true);

      const corrupt = join(directory, "corrupt.json");
      await writeFile(corrupt, "{", "utf8");
      await expect(scanner.scan(corrupt, "batch-3")).rejects.toMatchObject({ code: "invalid_snapshot" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
