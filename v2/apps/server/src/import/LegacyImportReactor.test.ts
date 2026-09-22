import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CommandId, EnvironmentId } from "@zli-v2/contracts";

import { Database } from "../db/Database.js";
import { Engine } from "../orchestration/Engine.js";
import { LegacyImportReactor } from "./LegacyImportReactor.js";

describe("LegacyImportReactor", () => {
  it("scans and imports through durable commands", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zli-legacy-reactor-"));
    const repository = join(directory, "repo");
    await mkdir(repository);
    const snapshot = join(directory, "legacy.json");
    await writeFile(
      snapshot,
      JSON.stringify({
        workspaces: [{ root: repository, project: { name: "repo", path: repository } }],
      }),
      "utf8",
    );
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
    const reactor = new LegacyImportReactor(engine);

    try {
      await engine.dispatchPromise({
        protocolVersion: 1,
        commandId: CommandId.parse("00000000-0000-4000-8000-000000000020"),
        command: { type: "legacy.scan", batchId: "batch-1", snapshotPath: snapshot },
      });
      await reactor.waitForIdle();
      const scanned = await engine.projection();
      const preview = scanned.legacyImport?.preview;
      expect(scanned.legacyImport?.status).toBe("ready");
      expect(preview?.projects[0]?.recordId).toBe("project:0");

      await engine.dispatchPromise({
        protocolVersion: 1,
        commandId: CommandId.parse("00000000-0000-4000-8000-000000000021"),
        command: { type: "legacy.import", batchId: "batch-1", selectedRecordIds: ["project:0"] },
      });
      await reactor.waitForIdle();
      expect((await engine.projection()).legacyImport?.status).toBe("imported");
      expect((await engine.projection()).projects).toHaveLength(1);
    } finally {
      reactor.stop();
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
