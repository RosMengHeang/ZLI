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
import { PairError, pairWithDesktop, previewPairingCode } from "./pairing.js";

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
