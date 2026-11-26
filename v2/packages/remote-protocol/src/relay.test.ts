import { describe, expect, it } from "vitest";

import { webCryptoRandomBytes as randomBytes, toBase64Url } from "./bytes.js";
import { Id16, Key32 } from "./messages.js";
import { RelayHostMessage, RelayRoute, relayUrl, roomIdFromSecret } from "./relay.js";

describe("relay room id", () => {
  it("is deterministic, 22 characters, and a valid Id16", () => {
    const secret = randomBytes(32);
    const room = roomIdFromSecret(secret);
    expect(roomIdFromSecret(secret)).toBe(room);
    expect(room).toHaveLength(22);
    expect(Id16.safeParse(room).success).toBe(true);
  });

  it("differs for different secrets", () => {
    expect(roomIdFromSecret(randomBytes(32))).not.toBe(roomIdFromSecret(randomBytes(32)));
  });
});

describe("relayUrl", () => {
  const route = RelayRoute.parse({ url: "wss://relay.example.com", room: roomIdFromSecret(randomBytes(32)) });

  it("builds the phone, host, and host session URLs", () => {
    const session = toBase64Url(randomBytes(16));
    expect(relayUrl(route, "phone")).toBe(`wss://relay.example.com/v1/phone/${route.room}`);
    expect(relayUrl(route, "host")).toBe(`wss://relay.example.com/v1/host/${route.room}`);
    expect(relayUrl(route, "host", session)).toBe(`wss://relay.example.com/v1/host/${route.room}/${session}`);
  });

  it("does not double the slash when the base URL ends with one", () => {
    expect(relayUrl({ ...route, url: "wss://relay.example.com/" }, "phone")).toBe(
      `wss://relay.example.com/v1/phone/${route.room}`,
    );
  });
});

describe("relayUrl hardening", () => {
  const room = roomIdFromSecret(randomBytes(32));

  it("throws on a malformed session or route", () => {
    const route = { url: "wss://h", room };
    expect(() => relayUrl(route, "host", "../x")).toThrow();
    expect(() => relayUrl({ url: "ws://h", room }, "phone")).toThrow();
  });

  it("keeps a path prefix", () => {
    expect(relayUrl({ url: "wss://h/base/", room }, "phone")).toBe(`wss://h/base/v1/phone/${room}`);
  });
});

describe("RelayRoute", () => {
  const room = roomIdFromSecret(randomBytes(32));

  it("accepts wss and rejects ws and http", () => {
    expect(RelayRoute.safeParse({ url: "wss://relay.example.com", room }).success).toBe(true);
    expect(RelayRoute.safeParse({ url: "ws://relay.example.com", room }).success).toBe(false);
    expect(RelayRoute.safeParse({ url: "http://relay.example.com", room }).success).toBe(false);
  });

  it("rejects a query, fragment, or credentials", () => {
    for (const url of ["wss://h/?x", "wss://h/#y", "wss://u:p@h"]) {
      expect(RelayRoute.safeParse({ url, room }).success).toBe(false);
    }
    expect(RelayRoute.safeParse({ url: "wss://h/base", room }).success).toBe(true);
  });

  it("fails cleanly on garbage URLs without throwing", () => {
    for (const url of ["wss://[", "wss://"]) {
      expect(RelayRoute.safeParse({ url, room }).success).toBe(false);
    }
  });
});

describe("RelayHostMessage", () => {
  it("parses claim, open, ping, and budget", () => {
    const secret = toBase64Url(randomBytes(32));
    const session = toBase64Url(randomBytes(16));
    expect(Key32.safeParse(secret).success).toBe(true);
    expect(RelayHostMessage.safeParse({ type: "claim", secret }).success).toBe(true);
    expect(RelayHostMessage.safeParse({ type: "open", session, client: "abc123" }).success).toBe(true);
    expect(RelayHostMessage.safeParse({ type: "ping" }).success).toBe(true);
    expect(RelayHostMessage.safeParse({ type: "budget" }).success).toBe(true);
  });

  it("rejects an oversized client key and unknown types", () => {
    const session = toBase64Url(randomBytes(16));
    expect(RelayHostMessage.safeParse({ type: "open", session, client: "x".repeat(65) }).success).toBe(false);
    expect(RelayHostMessage.safeParse({ type: "nope" }).success).toBe(false);
  });
});
