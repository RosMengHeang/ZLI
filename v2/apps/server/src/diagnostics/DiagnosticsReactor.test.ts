import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CommandId, EnvironmentId, ProjectId } from "@zli-v2/contracts";

import { Database } from "../db/Database.js";
import { Engine } from "../orchestration/Engine.js";
import { DiagnosticsReactor } from "./DiagnosticsReactor.js";

describe("DiagnosticsReactor", () => {
  it("creates a bundle from an RPC command and projects the result", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zli-diagnostics-reactor-"));
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
    const reactor = new DiagnosticsReactor(engine);
    const destination = join(directory, "support.zip");

    try {
      await engine.dispatch({
        protocolVersion: 1,
        commandId: CommandId.parse("00000000-0000-4000-8000-000000000010"),
        command: { type: "diagnostics.createSupportBundle", destinationPath: destination },
      });
      await reactor.waitForIdle();

      const projection = await engine.projection();
      expect(projection.diagnostics?.lastBundle?.path).toBe(destination);
      expect(projection.diagnostics?.lastBundle?.entries).toEqual([
        "manifest.json",
        "runtime.json",
        "logs.jsonl",
        "events.jsonl",
      ]);
      expect((await readFile(destination)).subarray(0, 4).toString("hex")).toBe("504b0304");
    } finally {
      reactor.stop();
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
