import { EnvironmentId } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import { hostsToTry, parseStoredPairing, type StoredPairing, serializePairing, withReady } from "./pairingRecord.js";

const key = `${"A".repeat(42)}A`;
const pairing: StoredPairing = {
  v: 1,
  desktopName: "Studio",
  hosts: ["192.168.1.20", "10.0.0.5"],
  port: 47321,
  desktopKey: key,
  deviceId: `${"B".repeat(21)}A`,
  credential: key,
  phoneSecret: key,
  deviceName: "Pixel",
  pairedAt: "2026-01-01T00:00:00.000Z",
};
const environmentId = EnvironmentId.parse("6f9619ff-8b86-4d01-b42d-00cf4fc964ff");

describe("stored pairing", () => {
  it("round-trips and rejects damaged or missing records", () => {
    expect(parseStoredPairing(serializePairing(pairing))).toEqual(pairing);
    expect(parseStoredPairing(null)).toBeUndefined();
    expect(parseStoredPairing("{not json")).toBeUndefined();
    expect(parseStoredPairing(JSON.stringify({ ...pairing, port: 0 }))).toBeUndefined();
  });

  it("tries the last working address first without repeating it", () => {
    expect(hostsToTry(pairing)).toEqual(["192.168.1.20", "10.0.0.5"]);
    expect(hostsToTry({ ...pairing, lastHost: "10.0.0.5" })).toEqual(["10.0.0.5", "192.168.1.20"]);
  });

  it("follows the desktop's new addresses and keeps the old ones after them", () => {
    const next = withReady(
      pairing,
      { type: "gateway.ready", desktopName: "Studio 2", environmentId, hosts: ["172.16.0.9"], port: 50000 },
      "10.0.0.5",
    );
    expect(next).toMatchObject({
      desktopName: "Studio 2",
      hosts: ["172.16.0.9", "10.0.0.5", "192.168.1.20"],
      port: 50000,
      lastHost: "10.0.0.5",
    });
  });
  it("parses an old stored pairing without relay fields", () => {
    expect(parseStoredPairing(JSON.stringify(pairing))).toEqual(pairing);
  });

  it("keeps the relay and records a LAN win", () => {
    const relay = { url: "wss://relay.example.com", room: `${"R".repeat(21)}A` };
    const next = withReady(
      { ...pairing, relay },
      { type: "gateway.ready", desktopName: "Studio", environmentId, hosts: [], port: 47321 },
      "10.0.0.5",
      "lan",
    );
    expect(next).toMatchObject({ relay, lastRoute: "lan", lastHost: "10.0.0.5" });
    expect(parseStoredPairing(serializePairing(next))).toEqual(next);
  });

  it("leaves lastHost alone after a relay win", () => {
    const next = withReady(
      { ...pairing, lastHost: "10.0.0.5" },
      { type: "gateway.ready", desktopName: "Studio", environmentId, hosts: ["172.16.0.9"], port: 47321 },
      undefined,
      "relay",
    );
    expect(next).toMatchObject({ lastRoute: "relay", lastHost: "10.0.0.5" });
    expect(next.hosts).toEqual(["172.16.0.9", "192.168.1.20", "10.0.0.5"]);
  });

  describe("the relay route the desktop reports", () => {
    const old = { url: "wss://relay.example.com", room: `${"R".repeat(21)}A` };
    const fresh = { url: "wss://relay.example.com", room: `${"S".repeat(21)}A` };
    const ready = { type: "gateway.ready" as const, desktopName: "Studio", environmentId, hosts: [], port: 47321 };

    it("sets it on a phone paired before the relay was on", () => {
      expect(withReady(pairing, { ...ready, relay: fresh }, "10.0.0.5").relay).toEqual(fresh);
    });

    it("replaces a rotated route", () => {
      expect(withReady({ ...pairing, relay: old }, { ...ready, relay: fresh }, "10.0.0.5").relay).toEqual(fresh);
    });

    it("clears it when a desktop that knows about the relay says it is off", () => {
      const next = withReady({ ...pairing, relay: old }, { ...ready, relay: null }, "10.0.0.5");
      expect(next).not.toHaveProperty("relay");
      expect(parseStoredPairing(serializePairing(next))).toEqual(next);
    });

    it("keeps it when an older desktop says nothing about the relay", () => {
      expect(withReady({ ...pairing, relay: old }, ready, "10.0.0.5").relay).toEqual(old);
    });
  });
});
