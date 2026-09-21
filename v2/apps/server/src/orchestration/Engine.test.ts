import { afterEach, describe, expect, it } from "vitest";

import { CommandId, EnvironmentId, type EnvironmentDescriptor } from "@zli-v2/contracts";

import { Database } from "../db/Database.js";
import { Engine, type EngineOptions, StoredEventCompatibilityError } from "./Engine.js";

const environment: EnvironmentDescriptor = {
  environmentId: EnvironmentId.parse("00000000-0000-4000-8000-000000000001"),
  label: "Test environment",
  protocolVersion: 1,
  capabilities: {
    eventReplay: true,
  },
};

const databaseInstances: Database[] = [];

function makeEngine(options: Partial<EngineOptions> = {}) {
  const database = new Database({ path: ":memory:" });
  databaseInstances.push(database);
  return new Engine({
    database,
    environment,
    ...options,
  });
}

function registerRequest(commandId: string, path: string) {
  return {
    protocolVersion: 1 as const,
    commandId: CommandId.parse(commandId),
    command: {
      type: "project.register" as const,
      path,
    },
  };
}

afterEach(() => {
  for (const database of databaseInstances.splice(0)) {
    database.close();
  }
});

describe("durable environment engine", () => {
  it("commits a receipt, event, and projection atomically", async () => {
    const engine = makeEngine();

    const receipt = await engine.dispatch(
      registerRequest("00000000-0000-4000-8000-000000000010", "C:\\workspace\\alpha"),
    );

    expect(receipt).toMatchObject({
      commandId: "00000000-0000-4000-8000-000000000010",
      status: "accepted",
      firstSequence: 1,
      lastSequence: 1,
      eventTypes: ["project.registered"],
    });
    expect((await engine.eventsAfter(0)).map((event) => event.event.type)).toEqual([
      "project.registered",
    ]);
    expect((await engine.projection()).projects).toHaveLength(1);
  });

  it("returns the original receipt for a duplicate command without replaying it", async () => {
    const engine = makeEngine();
    const request = registerRequest(
      "00000000-0000-4000-8000-000000000011",
      "C:\\workspace\\alpha",
    );

    const first = await engine.dispatch(request);
    const duplicate = await engine.dispatch(request);

    expect(duplicate).toEqual(first);
    expect(await engine.eventsAfter(0)).toHaveLength(1);
  });

  it("rejects reuse of a command id for a different intent", async () => {
    const engine = makeEngine();
    const commandId = "00000000-0000-4000-8000-000000000012";

    await engine.dispatch(registerRequest(commandId, "C:\\workspace\\alpha"));
    const conflict = await engine.dispatch(registerRequest(commandId, "C:\\workspace\\beta"));

    expect(conflict).toMatchObject({
      status: "rejected",
      error: { code: "command_id_conflict" },
    });
    expect(await engine.eventsAfter(0)).toHaveLength(1);
  });

  it("serializes concurrent commands and assigns monotonic event sequences", async () => {
    const engine = makeEngine();

    await Promise.all([
      engine.dispatch(registerRequest("00000000-0000-4000-8000-000000000013", "C:\\workspace\\a")),
      engine.dispatch(registerRequest("00000000-0000-4000-8000-000000000014", "C:\\workspace\\b")),
    ]);

    expect((await engine.eventsAfter(0)).map((event) => event.sequence)).toEqual([1, 2]);
    expect((await engine.projection()).projects).toHaveLength(2);
  });

  it("rolls back receipt, events, and projection when projection fails", async () => {
    const engine = makeEngine({
      projectEvent: () => {
        throw new Error("projection failed");
      },
    });

    await expect(
      engine.dispatch(registerRequest("00000000-0000-4000-8000-000000000015", "C:\\workspace\\broken")),
    ).rejects.toThrow("projection failed");
    expect(await engine.eventsAfter(0)).toEqual([]);
    expect((await engine.projection()).projects).toEqual([]);
    expect(await engine.receipt("00000000-0000-4000-8000-000000000015")).toBeUndefined();
  });

  it("runs reactors after commit and records reactor failures as events", async () => {
    const engine = makeEngine({
      reactors: [
        async () => {
          expect((await engine.eventsAfter(0)).map((event) => event.event.type)).toEqual([
            "project.registered",
          ]);
          throw new Error("reactor failed");
        },
      ],
    });

    const receipt = await engine.dispatch(
      registerRequest("00000000-0000-4000-8000-000000000016", "C:\\workspace\\reactor"),
    );
    await engine.waitForReactors();

    expect(receipt.status).toBe("accepted");
    expect((await engine.eventsAfter(0)).map((event) => event.event.type)).toEqual([
      "project.registered",
      "runtime.reactor.failed",
    ]);
  });

  it("rebuilds the projection from the append-only event log", async () => {
    const engine = makeEngine();
    await engine.dispatch(
      registerRequest("00000000-0000-4000-8000-000000000017", "C:\\workspace\\replay"),
    );

    await engine.rebuildProjection();

    const projection = await engine.projection();
    expect(projection.projects).toHaveLength(1);
    expect(projection.lastSequence).toBe(1);
  });

  it("reports incompatible stored events instead of silently dropping them", async () => {
    const engine = makeEngine();
    await engine.dispatch(
      registerRequest("00000000-0000-4000-8000-000000000018", "C:\\workspace\\stored"),
    );
    engine.database.execute("UPDATE events SET event_json = ? WHERE sequence = 1", ["{broken"]);

    await expect(engine.eventsAfter(0)).rejects.toBeInstanceOf(StoredEventCompatibilityError);
  });

  it("rejects a second project registration for the same path", async () => {
    const engine = makeEngine();
    await engine.dispatch(
      registerRequest("00000000-0000-4000-8000-000000000019", "C:\\workspace\\same"),
    );

    const duplicateProject = await engine.dispatch(
      registerRequest("00000000-0000-4000-8000-000000000020", "C:\\workspace\\same"),
    );

    expect(duplicateProject).toMatchObject({
      status: "rejected",
      error: { code: "project_exists" },
    });
    expect((await engine.projection()).projects).toHaveLength(1);
  });
});
