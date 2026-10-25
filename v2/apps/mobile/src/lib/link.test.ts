import { EnvironmentId } from "@zli-v2/contracts";
import {
  RemoteConnectError,
  type RemoteCloseInfo,
  type RemoteSession,
  type RemoteTransport,
  failureMessage,
  webCryptoRandomBytes,
} from "@zli-v2/remote-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RemoteLink } from "./link.js";
import type { StoredPairing } from "./pairingRecord.js";

const environmentId = EnvironmentId.parse("6f9619ff-8b86-4d01-b42d-00cf4fc964ff");
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
const environment = { environmentId, label: "Studio", protocolVersion: 1, capabilities: {} };
const projection = {
  environment,
  projects: [],
  worktrees: [],
  threads: [],
  terminals: [],
  browserTabs: [],
  attention: [],
  lastSequence: 0,
};

type FakeDesktop = { transport: RemoteTransport; sent: unknown[]; close(info: RemoteCloseInfo): void };

function fakeSession(): { session: RemoteSession; desktop: FakeDesktop } {
  const messageListeners = new Set<(message: unknown) => void>();
  const closeListeners = new Set<(info: RemoteCloseInfo) => void>();
  const sent: unknown[] = [];
  let closed = false;
  const emit = (message: unknown) =>
    queueMicrotask(() => {
      for (const listener of messageListeners) listener(message);
    });
  const close = (info: RemoteCloseInfo) => {
    if (closed) return;
    closed = true;
    for (const listener of closeListeners) listener(info);
  };
  const transport: RemoteTransport = {
    send(message) {
      sent.push(message);
      const type = (message as { type: string }).type;
      if (type === "hello") emit({ type: "hello", protocolVersion: 1, environment });
      if (type === "subscribe") emit({ type: "projection", projection });
    },
    close: () => close({ failure: "network", code: 1000 }),
    onMessage(listener) {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    onClose(listener) {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
  };
  return {
    session: {
      transport,
      ready: { type: "gateway.ready", desktopName: "Studio", environmentId, hosts: ["192.168.1.20"], port: 47321 },
    },
    desktop: { transport, sent, close },
  };
}

function makeLink(openSession: (url: string) => Promise<RemoteSession>, onPairingChange = vi.fn()) {
  return new RemoteLink({
    pairing,
    random: webCryptoRandomBytes,
    createSocket: () => {
      throw new Error("not used");
    },
    newId: () => crypto.randomUUID(),
    onPairingChange,
    openSession: (options) => openSession(options.url),
  });
}

async function until(check: () => boolean): Promise<void> {
  for (let index = 0; index < 200 && !check(); index += 1) await new Promise((resolve) => setTimeout(resolve, 1));
  expect(check()).toBe(true);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("RemoteLink", () => {
  it("connects through the first address that answers and loads the projection", async () => {
    const { session } = fakeSession();
    const urls: string[] = [];
    const onPairingChange = vi.fn();
    const link = makeLink(async (url) => {
      urls.push(url);
      if (url.includes("192.168.1.20")) throw new RemoteConnectError("network", failureMessage("network"));
      return session;
    }, onPairingChange);
    link.start();
    await until(() => link.getSnapshot().projection !== undefined);
    expect(urls).toEqual(["ws://192.168.1.20:47321/remote", "ws://10.0.0.5:47321/remote"]);
    expect(link.getSnapshot().state).toEqual({ kind: "online", host: "10.0.0.5" });
    expect(onPairingChange).toHaveBeenCalledWith(expect.objectContaining({ lastHost: "10.0.0.5" }));
    link.pause();
    await link.settled();
    expect(link.getSnapshot().state.kind).toBe("paused");
  });

  it("sends commands with a fresh command id", async () => {
    const { session, desktop } = fakeSession();
    const link = makeLink(async () => session);
    link.start();
    await until(() => link.getSnapshot().state.kind === "online");
    void link.command({ type: "thread.stop", threadId: "1b4e28ba-2fa1-4d2b-883f-0016d3cca427" }).catch(() => {});
    expect(desktop.sent.at(-1)).toMatchObject({
      type: "command",
      request: { protocolVersion: 1, command: { type: "thread.stop" } },
    });
    link.pause();
    await link.settled();
  });

  it("stops trying once the desktop no longer knows this phone", async () => {
    const link = makeLink(async () => {
      throw new RemoteConnectError("not-paired", failureMessage("not-paired"));
    });
    link.start();
    await until(() => link.getSnapshot().state.kind === "blocked");
    expect(link.getSnapshot().state).toEqual({ kind: "blocked", message: failureMessage("not-paired") });
    await link.settled();
  });

  it("reconnects after a dropped connection and blocks when the phone is revoked", async () => {
    const first = fakeSession();
    const second = fakeSession();
    const sessions = [first.session, second.session];
    const link = makeLink(async () => {
      const next = sessions.shift();
      if (!next) throw new RemoteConnectError("network", failureMessage("network"));
      return next;
    });
    link.start();
    await until(() => link.getSnapshot().generation === 1);
    first.desktop.close({ failure: "network", code: 1006 });
    await until(() => link.getSnapshot().state.kind === "offline");
    link.retryNow();
    await until(() => link.getSnapshot().generation === 2);
    second.desktop.close({ failure: "not-paired", code: 4003 });
    await until(() => link.getSnapshot().state.kind === "blocked");
    await expect(
      link.command({ type: "thread.stop", threadId: "1b4e28ba-2fa1-4d2b-883f-0016d3cca427" }),
    ).rejects.toThrow("Not connected");
  });

  it("waits and says why when no address answers", async () => {
    const link = makeLink(async () => {
      throw new RemoteConnectError("timeout", failureMessage("timeout"));
    });
    link.start();
    await until(() => link.getSnapshot().state.kind === "offline");
    expect(link.getSnapshot().state).toMatchObject({ kind: "offline", failure: "timeout" });
    link.pause();
    await link.settled();
    expect(link.getSnapshot().state.kind).toBe("paused");
  });
});
