import { describe, expect, it } from "vitest";

import { ClientControl, isControlType, ServerControl } from "./messages.js";

const token = "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]";

describe("ClientControl", () => {
  it("accepts a push token or a null one, with the platform", () => {
    expect(ClientControl.parse({ type: "gateway.push", token, platform: "ios" })).toEqual({
      type: "gateway.push",
      token,
      platform: "ios",
    });
    expect(
      ClientControl.parse({ type: "gateway.push", token: "ExpoPushToken[abc-123_x]", platform: "android" }),
    ).toBeTruthy();
    expect(ClientControl.parse({ type: "gateway.push", token: null, platform: "android" })).toMatchObject({
      token: null,
    });
  });

  it("refuses anything that is not an Expo push token", () => {
    for (const bad of [
      "",
      "https://example.com/hook",
      "ExponentPushToken[]",
      `ExponentPushToken[${"a".repeat(200)}]`,
    ]) {
      expect(ClientControl.safeParse({ type: "gateway.push", token: bad, platform: "ios" }).success).toBe(false);
    }
    expect(ClientControl.safeParse({ type: "gateway.push", token, platform: "web" }).success).toBe(false);
    expect(ClientControl.safeParse({ type: "gateway.push", platform: "ios" }).success).toBe(false);
  });

  it("accepts away with a boolean only", () => {
    expect(ClientControl.parse({ type: "gateway.away", away: true })).toEqual({ type: "gateway.away", away: true });
    expect(ClientControl.safeParse({ type: "gateway.away", away: "yes" }).success).toBe(false);
    expect(isControlType("gateway.away")).toBe(true);
  });
});

describe("ServerControl", () => {
  it("parses the gateway's wait for approval, and nothing else as its reason", () => {
    expect(ServerControl.parse({ type: "gateway.waiting", reason: "approval" })).toEqual({
      type: "gateway.waiting",
      reason: "approval",
    });
    expect(ServerControl.safeParse({ type: "gateway.waiting", reason: "other" }).success).toBe(false);
    expect(ServerControl.safeParse({ type: "gateway.waiting" }).success).toBe(false);
  });

  it("parses the gateway's refusal, refused or expired", () => {
    for (const reason of ["refused", "expired"] as const) {
      expect(ServerControl.parse({ type: "gateway.denied", reason })).toEqual({ type: "gateway.denied", reason });
    }
    expect(ServerControl.safeParse({ type: "gateway.denied", reason: "other" }).success).toBe(false);
  });

  it("parses gateway.ready with a relay route, with null for a relay turned off, and without one", () => {
    const ready = {
      type: "gateway.ready",
      desktopName: "Studio",
      environmentId: "6f9619ff-8b86-4d01-b42d-00cf4fc964ff",
      hosts: ["192.168.1.20"],
      port: 47321,
    };
    const relay = { url: "wss://relay.example.com", room: `${"R".repeat(21)}A` };
    expect(ServerControl.parse({ ...ready, relay })).toMatchObject({ relay });
    expect(ServerControl.parse({ ...ready, relay: null })).toMatchObject({ relay: null });
    expect(ServerControl.parse(ready)).not.toHaveProperty("relay");
    expect(
      ServerControl.safeParse({ ...ready, relay: { url: "ws://relay.example.com", room: relay.room } }).success,
    ).toBe(false);
  });
});
