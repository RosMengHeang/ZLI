import { CommandId, EnvironmentId } from "@zli-v2/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { Database } from "../db/Database.js";
import { HistoryRetention } from "../db/HistoryRetention.js";
import { Engine } from "./Engine.js";

const environment = {
  environmentId: EnvironmentId.parse("00000000-0000-4000-8000-000000000b01"),
  label: "History test",
  protocolVersion: 1 as const,
  capabilities: { structuredProviders: true, eventReplay: true },
};

const databases: Database[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

async function engineWithProjects(count: number) {
  const database = new Database({ path: ":memory:" });
  databases.push(database);
  const engine = new Engine({ database, environment });
  for (let index = 1; index <= count; index += 1) {
    await engine.dispatchPromise({
      protocolVersion: 1,
      commandId: CommandId.parse(`30000000-0000-4000-8000-${String(index).padStart(12, "0")}`),
      command: { type: "project.register", path: `C:\\workspace\\p${index}` },
    });
  }
  const count_ = () => (database.raw.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
  const receipts = () => (database.raw.prepare("SELECT COUNT(*) AS n FROM commands").get() as { n: number }).n;
  return { database, engine, events: count_, receipts };
}

describe("Engine history", () => {
  it("reads only the events of the asked types", async () => {
    const { engine } = await engineWithProjects(3);
    const registered = await engine.eventsOfTypes(["project.registered"]);
    expect(registered).toHaveLength(3);
    expect(registered.every((envelope) => envelope.event.type === "project.registered")).toBe(true);
    expect(await engine.eventsOfTypes([])).toEqual([]);
  });

  it("trims old events and receipts but keeps the newest event and the chosen types", async () => {
    const { engine, events, receipts } = await engineWithProjects(5);
    const before = events();
    expect(before).toBeGreaterThanOrEqual(5);
    const projects = (await engine.projection()).projects.length;

    // Everything is older than a cutoff in the future.
    const removed = await engine.trimHistory(new Date(Date.now() + 60_000), []);
    expect(removed.events).toBe(before - 1);
    expect(events()).toBe(1);
    expect(receipts()).toBeLessThan(5);
    // The saved state still has every project, and new events still get the next sequence.
    expect((await engine.projection()).projects).toHaveLength(projects);
    await engine.dispatchPromise({
      protocolVersion: 1,
      commandId: CommandId.parse("30000000-0000-4000-8000-000000000999"),
      command: { type: "project.register", path: "C:\\workspace\\after-trim" },
    });
    expect((await engine.projection()).projects).toHaveLength(projects + 1);
  });

  it("keeps event types reactors read back after a restart", async () => {
    const { engine, events } = await engineWithProjects(4);
    await engine.trimHistory(new Date(Date.now() + 60_000), ["project.registered"]);
    expect(events()).toBe((await engine.eventsOfTypes(["project.registered"])).length);
  });

  it("deletes nothing newer than the cutoff", async () => {
    const { engine, events } = await engineWithProjects(3);
    const before = events();
    const removed = await engine.trimHistory(new Date(Date.now() - 60_000), []);
    expect(removed).toEqual({ events: 0, receipts: 0 });
    expect(events()).toBe(before);
  });

  it("only trims when a shorter history is set", async () => {
    const { engine, events } = await engineWithProjects(3);
    let days: number | undefined;
    const later = Date.now() + 40 * 24 * 60 * 60_000;
    const retention = new HistoryRetention(
      engine,
      () => days,
      undefined,
      () => later,
    );
    expect(await retention.runOnce()).toBeUndefined();
    expect(events()).toBeGreaterThan(1);
    days = 30;
    expect((await retention.runOnce())?.events).toBeGreaterThan(0);
    expect(events()).toBe(1);
  });
});
