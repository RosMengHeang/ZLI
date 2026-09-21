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
});
