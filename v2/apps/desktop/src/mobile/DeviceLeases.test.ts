import { describe, expect, it } from "vitest";

import { DeviceBusyError, DeviceLeases } from "./DeviceLeases.js";

const agentA = { ownerId: "agent:a", ownerLabel: "The agent in app-a", kind: "agent" as const };
const agentB = { ownerId: "agent:b", ownerLabel: "The agent in app-b", kind: "agent" as const };
const person = { ownerId: "person", ownerLabel: "You", kind: "person" as const };

describe("device leases", () => {
  it("lets one agent hold a device and renews it on each action", () => {
    let now = 0;
    const leases = new DeviceLeases({ now: () => now, agentLeaseMs: 1_000 });
    leases.acquire("d", agentA);
    now = 900;
    const renewed = leases.acquire("d", agentA);
    expect(renewed.expiresAt).toBe(new Date(1_900).toISOString());
    expect(renewed.acquiredAt).toBe(new Date(0).toISOString());
    expect(() => leases.acquire("d", agentB)).toThrow(DeviceBusyError);
  });

  it("lapses an agent's lease after the quiet period", () => {
    let now = 0;
    const leases = new DeviceLeases({ now: () => now, agentLeaseMs: 1_000 });
    leases.acquire("d", agentA);
    now = 1_000;
    expect(leases.get("d")).toBeNull();
    expect(leases.acquire("d", agentB).ownerId).toBe("agent:b");
  });

  it("lets the person take over from an agent, and keeps agents out until they hand it back", () => {
    let changes = 0;
    const leases = new DeviceLeases({ onChange: () => (changes += 1) });
    leases.acquire("d", agentA);
    const taken = leases.acquire("d", person);
    expect(taken.expiresAt).toBeUndefined();
    expect(() => leases.acquire("d", agentA)).toThrow(/took over/u);
    expect(leases.release("d", "agent:a")).toBe(false);
    expect(leases.release("d")).toBe(true);
    expect(leases.acquire("d", agentA).ownerId).toBe("agent:a");
    expect(changes).toBe(4);
  });

  it("lists what an owner holds", () => {
    const leases = new DeviceLeases();
    leases.acquire("one", agentA);
    leases.acquire("two", agentA);
    leases.acquire("three", agentB);
    expect(leases.heldBy("agent:a")).toEqual(["one", "two"]);
  });
});
