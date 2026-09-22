import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EnvironmentId } from "@zli-v2/contracts";

import { Database } from "../db/Database.js";
import { Engine } from "../orchestration/Engine.js";
import { LegacyImporter } from "./LegacyImporter.js";
import { LegacyScanner } from "./LegacyScanner.js";

describe("LegacyImporter", () => {
  it("imports selected ready records idempotently and rolls back only created records", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zli-legacy-import-"));
    const repository = join(directory, "repo");
    const worktree = join(directory, "worktree");
    await mkdir(repository);
    await mkdir(worktree);
    const database = new Database({ path: join(directory, "runtime.sqlite") });
    const engine = new Engine({
      database,
      environment: {
        environmentId: EnvironmentId.parse("00000000-0000-4000-8000-000000000001"),
        label: "test",
        protocolVersion: 1,
        capabilities: { eventReplay: true },
      },
    });

    try {
      const preview = await new LegacyScanner().scanValue({
        workspaces: [{
          root: repository,
          project: { name: "repo", path: repository },
          agents: [{ name: "Codex", provider: "codex", worktreePath: worktree, branch: "feature/import" }],
        }],
      }, join(directory, "legacy.json"), "batch-1");
      const importer = new LegacyImporter(engine);
      const selected = preview.projects.map((item) => item.recordId).concat(preview.worktrees.map((item) => item.recordId));
      const first = await importer.import(preview, selected);
      expect(first.importedProjectIds).toHaveLength(1);
      expect(first.importedWorktreeIds).toHaveLength(1);
      expect((await engine.projection()).worktrees).toHaveLength(1);

      const repeated = await importer.import(preview, selected);
      expect(repeated.importedProjectIds).toEqual([]);
      expect(repeated.importedWorktreeIds).toEqual([]);
      expect((await engine.projection()).projects).toHaveLength(1);

      await importer.rollback(first);
      const projection = await engine.projection();
      expect(projection.projects).toEqual([]);
      expect(projection.worktrees).toEqual([]);
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rolls back the records already created when a later worktree is rejected", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zli-legacy-partial-"));
    const repository = join(directory, "repo");
    const firstWorktree = join(directory, "first-worktree");
    const secondWorktree = join(directory, "second-worktree");
    await mkdir(repository);
    await mkdir(firstWorktree);
    await mkdir(secondWorktree);
    const database = new Database({ path: join(directory, "runtime.sqlite") });
    const engine = new Engine({
      database,
      environment: {
        environmentId: EnvironmentId.parse("00000000-0000-4000-8000-000000000001"),
        label: "test",
        protocolVersion: 1,
        capabilities: { eventReplay: true },
      },
    });
    try {
      const preview = {
        batchId: "partial-batch",
        snapshotPath: join(directory, "legacy.json"),
        projects: [{ recordId: "project:0", name: "repo", path: repository, repositoryRoot: repository, state: "ready" as const }],
        worktrees: [
          { recordId: "worktree:0:0", projectRecordId: "project:0", path: firstWorktree, branch: "feature/good", state: "ready" as const },
          { recordId: "worktree:0:1", projectRecordId: "project:0", path: secondWorktree, branch: "-rejected", state: "ready" as const },
        ],
        sessions: [],
        skipped: [],
        conflicts: [],
      };
      const selected = ["project:0", "worktree:0:0", "worktree:0:1"];
      await expect(new LegacyImporter(engine).import(preview, selected)).rejects.toThrow("Unsafe Git ref: -rejected");
      expect((await engine.projection()).projects).toEqual([]);
      expect((await engine.projection()).worktrees).toEqual([]);
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
