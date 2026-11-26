import {
  encodePairingCode,
  failureMessage,
  RemoteConnectError,
  type RemoteSession,
  toBase64Url,
  webCryptoRandomBytes,
} from "@zli-v2/remote-protocol";
import { describe, expect, it, vi } from "vitest";

import { ids } from "./fixtures.js";
import { PairError, pairingCodeFromLink, pairWithDesktop, previewPairingCode } from "./pairing.js";

const now = 1_800_000_000_000;
const code = encodePairingCode({
  v: 1,
  name: "Studio",
  hosts: ["192.168.1.20", "10.0.0.5"],
  port: 47321,
  key: toBase64Url(webCryptoRandomBytes(32)),
  pairingId: toBase64Url(webCryptoRandomBytes(16)),
  secret: toBase64Url(webCryptoRandomBytes(32)),
  expiresAt: now + 60_000,
});

const deps = (openSession: (url: string) => Promise<RemoteSession>) => ({
  random: webCryptoRandomBytes,
  createSocket: () => {
    throw new Error("not used");
  },
  now: () => now,
  openSession: (options: { url: string }) => openSession(options.url),
});

function pairedSession(close = vi.fn()): RemoteSession {
  return {
    transport: { send: vi.fn(), close, onMessage: () => () => {}, onClose: () => () => {} },
    ready: {
      type: "gateway.ready",
      desktopName: "Studio",
      environmentId: ids.environment as RemoteSession["ready"]["environmentId"],
      hosts: ["10.0.0.5"],
      port: 47321,
    },
    paired: { deviceId: toBase64Url(webCryptoRandomBytes(16)), credential: toBase64Url(webCryptoRandomBytes(32)) },
  };
}

describe("previewPairingCode", () => {
  it("names the desktop or says why the code is unusable", () => {
    expect(previewPairingCode(code, now)).toEqual({ desktopName: "Studio" });
    expect(previewPairingCode(code, now + 120_000)).toEqual({
      error: "This pairing code expired. Make a new one on the desktop.",
    });
    expect(previewPairingCode("hello", now)).toEqual({ error: "This is not a ZLI pairing code." });
  });
});

describe("pairWithDesktop", () => {
  it("tries each address, closes the pairing session, and keeps what reconnecting needs", async () => {
    const close = vi.fn();
    const urls: string[] = [];
    const pairing = await pairWithDesktop(
      code,
      "Pixel",
      deps(async (url) => {
        urls.push(url);
        if (urls.length === 1) throw new RemoteConnectError("timeout", failureMessage("timeout"));
        return pairedSession(close);
      }),
    );
    expect(urls).toHaveLength(2);
    expect(close).toHaveBeenCalled();
    expect(pairing).toMatchObject({ desktopName: "Studio", deviceName: "Pixel", lastHost: "10.0.0.5", port: 47321 });
  });

  it("keeps the relay from the code and pairs through it when the LAN is stale", async () => {
    const relay = { url: "wss://relay.example.com", room: toBase64Url(webCryptoRandomBytes(16)) };
    const relayCode = encodePairingCode({
      v: 1,
      name: "Studio",
      hosts: ["192.168.1.20"],
      port: 47321,
      key: toBase64Url(webCryptoRandomBytes(32)),
      pairingId: toBase64Url(webCryptoRandomBytes(16)),
      secret: toBase64Url(webCryptoRandomBytes(32)),
      expiresAt: now + 60_000,
      relay,
    });
    const urls: string[] = [];
    const pairing = await pairWithDesktop(
      relayCode,
      "Pixel",
      deps(async (url) => {
        urls.push(url);
        if (url.startsWith("ws://")) throw new RemoteConnectError("network", failureMessage("network"));
        return pairedSession();
      }),
    );
    expect(urls).toEqual(["ws://192.168.1.20:47321/remote", `wss://relay.example.com/v1/phone/${relay.room}`]);
    expect(pairing).toMatchObject({ relay, lastRoute: "relay" });
    expect(pairing.lastHost).toBeUndefined();
  });

  it("pairs over a slow LAN without ever opening the relay", async () => {
    vi.useFakeTimers();
    const relay = { url: "wss://relay.example.com", room: toBase64Url(webCryptoRandomBytes(16)) };
    const relayCode = encodePairingCode({
      v: 1,
      name: "Studio",
      hosts: ["192.168.1.20"],
      port: 47321,
      key: toBase64Url(webCryptoRandomBytes(32)),
      pairingId: toBase64Url(webCryptoRandomBytes(16)),
      secret: toBase64Url(webCryptoRandomBytes(32)),
      expiresAt: now + 60_000,
      relay,
    });
    const urls: string[] = [];
    const pending = pairWithDesktop(
      relayCode,
      "Pixel",
      deps((url) => {
        urls.push(url);
        return new Promise((resolve) => setTimeout(() => resolve(pairedSession()), 3_000));
      }),
    );
    await vi.advanceTimersByTimeAsync(3_100);
    const pairing = await pending;
    vi.useRealTimers();
    expect(urls).toEqual(["ws://192.168.1.20:47321/remote"]);
    expect(pairing.lastRoute).toBe("lan");
  });

  it("stops at a used code instead of trying the next address", async () => {
    const open = vi.fn(async () => {
      throw new RemoteConnectError("pairing-code", failureMessage("pairing-code"));
    });
    await expect(pairWithDesktop(code, "Pixel", deps(open))).rejects.toThrow(failureMessage("pairing-code"));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("explains an unreachable desktop and an unnamed phone", async () => {
    const unreachable = deps(async () => {
      throw new RemoteConnectError("network", failureMessage("network"));
    });
    await expect(pairWithDesktop(code, "Pixel", unreachable)).rejects.toThrow(/Could not reach Studio/u);
    await expect(pairWithDesktop(code, "  ", unreachable)).rejects.toBeInstanceOf(PairError);
  });
});

describe("pairingCodeFromLink", () => {
  it("takes a zli-remote: link as the code", () => {
    expect(pairingCodeFromLink(` ${code} `)).toBe(code);
  });

  it("reads the code parameter of another link", () => {
    expect(pairingCodeFromLink(`exp://10.0.2.2:8081/--/pair?code=${encodeURIComponent(code)}`)).toBe(code);
  });

  it("ignores links without a pairing code", () => {
    expect(pairingCodeFromLink("exp://10.0.2.2:8081")).toBeUndefined();
    expect(pairingCodeFromLink("https://example.com/?code=hello")).toBeUndefined();
    expect(pairingCodeFromLink("https://example.com/?code=%E0%A4%A")).toBeUndefined();
  });
});
