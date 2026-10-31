import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import * as Effect from "effect/Effect";

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
  it("exposes command dispatch as a lazy Effect", async () => {
    const engine = makeEngine();
    const dispatch = engine.dispatch(registerRequest("00000000-0000-4000-8000-000000000009", "C:\\workspace\\effect"));

    expect(await engine.eventsAfter(0)).toEqual([]);
    const receipt = await Effect.runPromise(dispatch);

    expect(receipt.status).toBe("accepted");
    expect((await engine.eventsAfter(0)).map((event) => event.event.type)).toEqual(["project.registered"]);
  });

  it("commits a receipt, event, and projection atomically", async () => {
    const engine = makeEngine();

    const receipt = await engine.dispatchPromise(
      registerRequest("00000000-0000-4000-8000-000000000010", "C:\\workspace\\alpha"),
    );

    expect(receipt).toMatchObject({
      commandId: "00000000-0000-4000-8000-000000000010",
      status: "accepted",
      firstSequence: 1,
      lastSequence: 1,
      eventTypes: ["project.registered"],
    });
    expect((await engine.eventsAfter(0)).map((event) => event.event.type)).toEqual(["project.registered"]);
    expect((await engine.projection()).projects).toHaveLength(1);
  });

  it("returns the original receipt for a duplicate command without replaying it", async () => {
    const engine = makeEngine();
    const request = registerRequest("00000000-0000-4000-8000-000000000011", "C:\\workspace\\alpha");

    const first = await engine.dispatchPromise(request);
    const duplicate = await engine.dispatchPromise(request);

    expect(duplicate).toEqual(first);
    expect(await engine.eventsAfter(0)).toHaveLength(1);
  });

  it("rejects reuse of a command id for a different intent", async () => {
    const engine = makeEngine();
    const commandId = "00000000-0000-4000-8000-000000000012";

    await engine.dispatchPromise(registerRequest(commandId, "C:\\workspace\\alpha"));
    const conflict = await engine.dispatchPromise(registerRequest(commandId, "C:\\workspace\\beta"));

    expect(conflict).toMatchObject({
      status: "rejected",
      error: { code: "command_id_conflict" },
    });
    expect(await engine.eventsAfter(0)).toHaveLength(1);
  });

  it("serializes concurrent commands and assigns monotonic event sequences", async () => {
    const engine = makeEngine();

    await Promise.all([
      engine.dispatchPromise(registerRequest("00000000-0000-4000-8000-000000000013", "C:\\workspace\\a")),
      engine.dispatchPromise(registerRequest("00000000-0000-4000-8000-000000000014", "C:\\workspace\\b")),
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
      engine.dispatchPromise(registerRequest("00000000-0000-4000-8000-000000000015", "C:\\workspace\\broken")),
    ).rejects.toThrow("projection failed");
    expect(await engine.eventsAfter(0)).toEqual([]);
    expect((await engine.projection()).projects).toEqual([]);
    expect(await engine.receipt("00000000-0000-4000-8000-000000000015")).toBeUndefined();
  });

  it("runs reactors after commit and records reactor failures as events", async () => {
    const engine = makeEngine({
      reactors: [
        async () => {
          expect((await engine.eventsAfter(0)).map((event) => event.event.type)).toEqual(["project.registered"]);
          throw new Error("reactor failed");
        },
      ],
    });

    const receipt = await engine.dispatchPromise(
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
    await engine.dispatchPromise(registerRequest("00000000-0000-4000-8000-000000000017", "C:\\workspace\\replay"));

    await engine.rebuildProjection();

    const projection = await engine.projection();
    expect(projection.projects).toHaveLength(1);
    expect(projection.lastSequence).toBe(1);
  });

  it("stores the projection periodically and replays newer events when it is loaded", async () => {
    const engine = makeEngine();
    const storedRevision = () =>
      (
        engine.database.raw.prepare("SELECT revision FROM projection_state WHERE projection_id = 1").get() as
          | { revision: number }
          | undefined
      )?.revision;
    await engine.dispatchPromise(registerRequest("00000000-0000-4000-8000-000000000021", "C:\\workspace\\one"));
    await engine.dispatchPromise(registerRequest("00000000-0000-4000-8000-000000000022", "C:\\workspace\\two"));

    expect(storedRevision()).toBeUndefined();
    const reopened = new Engine({ database: engine.database, environment });
    const replayed = await reopened.projection();
    expect(replayed.lastSequence).toBe(2);
    expect(replayed.projects.map((project) => project.path)).toEqual(["C:\\workspace\\one", "C:\\workspace\\two"]);

    await engine.flushProjection();
    expect(storedRevision()).toBe(2);
    expect(await new Engine({ database: engine.database, environment }).projection()).toEqual(replayed);
  });

  it("replays the whole log once when a migration asks for a rebuild", async () => {
    const engine = makeEngine();
    await engine.dispatchPromise(registerRequest("00000000-0000-4000-8000-000000000031", "C:\\workspace\\one"));
    await engine.dispatchPromise(registerRequest("00000000-0000-4000-8000-000000000032", "C:\\workspace\\two"));
    await engine.flushProjection();
    const stored = JSON.parse(
      (
        engine.database.raw.prepare("SELECT projection_json FROM projection_state WHERE projection_id = 1").get() as {
          projection_json: string;
        }
      ).projection_json,
    );
    engine.database.execute("UPDATE projection_state SET projection_json = ? WHERE projection_id = 1", [
      JSON.stringify({ ...stored, projects: [] }),
    ]);
    engine.database.execute("INSERT INTO projection_rebuilds (reason, requested_at) VALUES ('test', 'now')");

    const reopened = await new Engine({ database: engine.database, environment }).projection();

    expect(reopened.projects.map((project) => project.path)).toEqual(["C:\\workspace\\one", "C:\\workspace\\two"]);
    expect(engine.database.raw.prepare("SELECT COUNT(*) AS count FROM projection_rebuilds").get()).toEqual({
      count: 0,
    });
  });

  it("keeps the stored projection when an old event no longer parses during a rebuild", async () => {
    const engine = makeEngine();
    await engine.dispatchPromise(registerRequest("00000000-0000-4000-8000-000000000033", "C:\\workspace\\kept"));
    await engine.flushProjection();
    const before = await engine.projection();
    engine.database.execute("UPDATE events SET event_json = ? WHERE sequence = 1", ["{broken"]);
    engine.database.execute("INSERT INTO projection_rebuilds (reason, requested_at) VALUES ('test', 'now')");

    const reopened = await new Engine({ database: engine.database, environment }).projection();

    expect(reopened).toEqual(before);
    expect(engine.database.raw.prepare("SELECT COUNT(*) AS count FROM projection_rebuilds").get()).toEqual({
      count: 0,
    });
  });

  it("stores the projection again once enough events accumulate", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    onTestFinished(() => now.mockRestore());
    const engine = makeEngine();
    for (let index = 0; index < 100; index += 1) {
      const suffix = String(100 + index).padStart(12, "0");
      await engine.dispatchPromise(registerRequest(`00000000-0000-4000-8000-${suffix}`, `C:\\workspace\\p${index}`));
    }

    const row = engine.database.raw.prepare("SELECT revision FROM projection_state WHERE projection_id = 1").get() as
      | { revision: number }
      | undefined;
    expect(row?.revision).toBe(100);
  });

  it("reports incompatible stored events instead of silently dropping them", async () => {
    const engine = makeEngine();
    await engine.dispatchPromise(registerRequest("00000000-0000-4000-8000-000000000018", "C:\\workspace\\stored"));
    engine.database.execute("UPDATE events SET event_json = ? WHERE sequence = 1", ["{broken"]);

    await expect(engine.eventsAfter(0)).rejects.toBeInstanceOf(StoredEventCompatibilityError);
  });

  it("rejects a second project registration for the same path", async () => {
    const engine = makeEngine();
    await engine.dispatchPromise(registerRequest("00000000-0000-4000-8000-000000000019", "C:\\workspace\\same"));

    const duplicateProject = await engine.dispatchPromise(
      registerRequest("00000000-0000-4000-8000-000000000020", "C:\\workspace\\same"),
    );

    expect(duplicateProject).toMatchObject({
      status: "rejected",
      error: { code: "project_exists" },
    });
    expect((await engine.projection()).projects).toHaveLength(1);
  });
});
