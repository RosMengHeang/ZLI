import { EnvironmentId } from "@zli-v2/contracts";
import {
  failureMessage,
  generateKeyPair,
  RemoteCloseCode,
  type RemoteCloseInfo,
  RemoteConnectError,
  type RemoteSession,
  type RemoteTransport,
  toBase64Url,
  type WebSocketLike,
  webCryptoRandomBytes,
} from "@zli-v2/remote-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type LinkOptions, RemoteLink } from "./link.js";
import type { StoredPairing } from "./pairingRecord.js";
import type { PushRegistration } from "./push.js";

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

function fakeSession(ready: Partial<RemoteSession["ready"]> = {}): { session: RemoteSession; desktop: FakeDesktop } {
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
      ready: {
        type: "gateway.ready",
        desktopName: "Studio",
        environmentId,
        hosts: ["192.168.1.20"],
        port: 47321,
        ...ready,
      },
    },
    desktop: { transport, sent, close },
  };
}

function makeLink(
  openSession: (url: string) => Promise<RemoteSession>,
  onPairingChange = vi.fn(),
  extra: Partial<LinkOptions> = {},
) {
  return new RemoteLink({
    pairing,
    random: webCryptoRandomBytes,
    createSocket: () => {
      throw new Error("not used");
    },
    newId: () => crypto.randomUUID(),
    onPairingChange,
    openSession: (options) => openSession(options.url),
    ...extra,
  });
}

const controls = (sent: unknown[]) =>
  sent.filter((message) => (message as { type: string }).type.startsWith("gateway."));

async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 1));
  expect(check()).toBe(true);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("RemoteLink", () => {
  it("gives a desktop that takes them the push token after each connection, and the away state", async () => {
    const { session, desktop } = fakeSession({ push: true });
    const token = "ExponentPushToken[abc]";
    const pushRegistration = vi.fn(async (): Promise<PushRegistration> => ({ token, platform: "ios" }));
    const link = makeLink(async () => session, vi.fn(), { pushRegistration });
    link.setAway(true);
    link.start();
    await until(() => controls(desktop.sent).length === 2);
    expect(controls(desktop.sent)).toEqual([
      { type: "gateway.away", away: true },
      { type: "gateway.push", token, platform: "ios" },
    ]);
    link.setAway(false);
    link.setAway(false);
    pushRegistration.mockResolvedValueOnce({ token: null, platform: "ios" });
    link.refreshPush();
    await until(() => controls(desktop.sent).length === 4);
    expect(controls(desktop.sent).slice(2)).toEqual([
      { type: "gateway.away", away: false },
      { type: "gateway.push", token: null, platform: "ios" },
    ]);
    link.pause();
    await link.settled();
  });

  it("sends no control messages to an older desktop, or when push is unavailable", async () => {
    const older = fakeSession();
    const pushRegistration = vi.fn(async () => ({ token: "ExponentPushToken[abc]", platform: "ios" as const }));
    const link = makeLink(async () => older.session, vi.fn(), { pushRegistration });
    link.start();
    await until(() => link.getSnapshot().state.kind === "online");
    link.setAway(true);
    link.refreshPush();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(pushRegistration).not.toHaveBeenCalled();
    expect(controls(older.desktop.sent)).toEqual([]);
    link.pause();
    await link.settled();

    const current = fakeSession({ push: true });
    const failing = makeLink(async () => current.session, vi.fn(), {
      pushRegistration: async () => {
        throw new Error("no aps-environment entitlement");
      },
    });
    failing.start();
    await until(() => failing.getSnapshot().state.kind === "online");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(controls(current.desktop.sent)).toEqual([]);
    expect(failing.getSnapshot().state.kind).toBe("online");
    failing.pause();
    await failing.settled();
  });

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

  it("falls back to the relay when the LAN is stale, and records the route", async () => {
    const { session } = fakeSession();
    const relay = { url: "wss://relay.example.com", room: `${"R".repeat(21)}A` };
    const urls: string[] = [];
    const onPairingChange = vi.fn();
    const link = makeLink(
      async (url) => {
        urls.push(url);
        if (!url.startsWith("wss://")) throw new RemoteConnectError("network", failureMessage("network"));
        return session;
      },
      onPairingChange,
      { pairing: { ...pairing, relay, lastHost: "10.0.0.5" } },
    );
    link.start();
    await until(() => link.getSnapshot().state.kind === "online");
    expect(urls.at(-1)).toBe(`wss://relay.example.com/v1/phone/${relay.room}`);
    expect(link.getSnapshot().route).toBe("relay");
    expect(link.getSnapshot().state).toEqual({ kind: "online" });
    expect(onPairingChange).toHaveBeenCalledWith(expect.objectContaining({ relay, lastRoute: "relay" }));
    // The address that failed is no longer tried first; the desktop's own list leads.
    expect(link.getSnapshot().pairing.lastHost).toBeUndefined();
    expect(link.getSnapshot().pairing.hosts[0]).toBe("192.168.1.20");
    link.pause();
    await link.settled();
  });

  it("reaches the working LAN host within about 3 s when the first one is a dead address", async () => {
    const relay = { url: "wss://relay.example.com", room: `${"R".repeat(21)}A` };
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const { session } = fakeSession();
    const link = new RemoteLink({
      pairing: { ...pairing, relay, lastHost: "10.0.0.5" },
      random: webCryptoRandomBytes,
      createSocket: () => {
        throw new Error("not used");
      },
      newId: () => crypto.randomUUID(),
      // Stands in for the client: a dead address never opens, so the attempt ends at the open deadline.
      openSession: async (options) => {
        if (options.url.includes("10.0.0.5")) {
          await delay(options.openTimeoutMs ?? options.timeoutMs ?? 10_000);
          throw new RemoteConnectError("network", failureMessage("network"));
        }
        // The relay is a round trip through the internet, so it is slower than a LAN host.
        if (options.url.startsWith("wss://")) await delay(2_500);
        return session;
      },
    });
    const started = Date.now();
    link.start();
    await until(() => link.getSnapshot().state.kind === "online", 4_000);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(link.getSnapshot().route).toBe("lan");
    expect(link.getSnapshot().state).toEqual({ kind: "online", host: "192.168.1.20" });
    link.pause();
    await link.settled();
  });

  it("moves from the relay to the LAN when a background probe finds the desktop", async () => {
    const relay = { url: "wss://relay.example.com", room: `${"R".repeat(21)}A` };
    const relayed = fakeSession();
    const local = fakeSession();
    let lanUp = false;
    const urls: string[] = [];
    const link = makeLink(
      async (url) => {
        urls.push(url);
        if (url.startsWith("wss://")) return relayed.session;
        if (!lanUp) throw new RemoteConnectError("network", failureMessage("network"));
        return local.session;
      },
      vi.fn(),
      { pairing: { ...pairing, relay }, lanProbeMs: 30 },
    );
    const relayClosed = new Promise<void>((resolve) => relayed.session.transport.onClose(() => resolve()));
    link.start();
    await until(() => link.getSnapshot().route === "relay");
    const generation = link.getSnapshot().generation;
    lanUp = true;
    await until(() => link.getSnapshot().route === "lan", 2_000);
    expect(link.getSnapshot().state).toEqual({ kind: "online", host: "192.168.1.20" });
    expect(link.getSnapshot().generation).toBe(generation + 1);
    expect(link.getSnapshot().pairing).toMatchObject({ lastRoute: "lan", lastHost: "192.168.1.20" });
    await relayClosed;
    // The switch is not a drop: the link stays on the LAN session and does not race again.
    const attempts = urls.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(link.getSnapshot().route).toBe("lan");
    expect(urls.length).toBe(attempts);
    link.pause();
    await link.settled();
  });

  it("keeps the relay session when the background probe finds nothing", async () => {
    const relay = { url: "wss://relay.example.com", room: `${"R".repeat(21)}A` };
    const relayed = fakeSession();
    let probes = 0;
    const link = makeLink(
      async (url) => {
        if (url.startsWith("wss://")) return relayed.session;
        probes += 1;
        throw new RemoteConnectError("network", failureMessage("network"));
      },
      vi.fn(),
      { pairing: { ...pairing, relay }, lanProbeMs: 20 },
    );
    link.start();
    await until(() => link.getSnapshot().route === "relay");
    const first = probes;
    await until(() => probes >= first + 4, 2_000);
    expect(link.getSnapshot()).toMatchObject({ route: "relay", state: { kind: "online" } });
    link.pause();
    await link.settled();
    const stopped = probes;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(probes).toBe(stopped);
  });

  it("says the PC is unreachable, not 'same network', when the relay failed too", async () => {
    const relay = { url: "wss://relay.example.com", room: `${"R".repeat(21)}A` };
    const link = makeLink(
      async () => {
        throw new RemoteConnectError("network", failureMessage("network"));
      },
      vi.fn(),
      { pairing: { ...pairing, relay } },
    );
    link.start();
    await until(() => link.getSnapshot().state.kind === "offline");
    expect(link.getSnapshot().state).toMatchObject({
      message: "Your PC is not reachable. Check that it is on and connected to the internet.",
    });
    link.pause();
    await link.settled();
  });

  it("says the PC is unreachable when the relay closes with desktop offline", async () => {
    const relay = { url: "wss://relay.example.com", room: `${"R".repeat(21)}A` };
    // The real client, over a socket that opens and is then closed the way the relay closes it.
    const createSocket = () => {
      const socket = {
        binaryType: "arraybuffer",
        readyState: 0,
        send() {},
        close() {},
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
      } as unknown as WebSocketLike;
      setTimeout(() => {
        socket.onopen?.({});
        socket.onclose?.({ code: RemoteCloseCode.desktopOffline });
      }, 0);
      return socket;
    };
    // Real keys, since the real client runs the handshake math before it sends the hello.
    const desktop = generateKeyPair(webCryptoRandomBytes);
    const phone = generateKeyPair(webCryptoRandomBytes);
    const link = new RemoteLink({
      pairing: {
        ...pairing,
        relay,
        lastRoute: "relay",
        desktopKey: toBase64Url(desktop.publicKey),
        phoneSecret: toBase64Url(phone.secretKey),
      },
      random: webCryptoRandomBytes,
      createSocket,
      newId: () => crypto.randomUUID(),
      onPairingChange: vi.fn(),
    });
    link.start();
    await until(() => link.getSnapshot().state.kind === "offline");
    expect(link.getSnapshot().state).toMatchObject({
      message: "Your PC is not reachable. Check that it is on and connected to the internet.",
    });
    link.pause();
    await link.settled();
  });

  it("keeps the pairing and retries when only the relay says this phone is not paired", async () => {
    const relay = { url: "wss://relay.example.com", room: `${"R".repeat(21)}A` };
    const onPairingChange = vi.fn();
    const link = makeLink(
      async (url) => {
        if (url.startsWith("wss://")) throw new RemoteConnectError("not-paired", failureMessage("not-paired"));
        throw new RemoteConnectError("network", failureMessage("network"));
      },
      onPairingChange,
      { pairing: { ...pairing, relay } },
    );
    link.start();
    await until(() => link.getSnapshot().state.kind === "offline");
    expect(link.getSnapshot().state).toMatchObject({ failure: "not-paired", message: failureMessage("not-paired") });
    expect(link.getSnapshot().pairing).toEqual({ ...pairing, relay });
    expect(onPairingChange).not.toHaveBeenCalled();
    link.pause();
    await link.settled();
  });

  it("uses the unreachable message for a relay pairing that timed out", async () => {
    const relay = { url: "wss://relay.example.com", room: `${"R".repeat(21)}A` };
    const link = makeLink(
      async () => {
        throw new RemoteConnectError("timeout", failureMessage("timeout"));
      },
      vi.fn(),
      { pairing: { ...pairing, relay } },
    );
    link.start();
    await until(() => link.getSnapshot().state.kind === "offline");
    expect(link.getSnapshot().state).toMatchObject({
      message: "Your PC is not reachable. Check that it is on and connected to the internet.",
    });
    link.pause();
    await link.settled();
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

  it("keeps the pairing and retries when a relay session is closed as not paired", async () => {
    const relay = { url: "wss://relay.example.com", room: `${"R".repeat(21)}A` };
    const { session, desktop } = fakeSession();
    const link = makeLink(
      async (url) => {
        if (!url.startsWith("wss://")) throw new RemoteConnectError("network", failureMessage("network"));
        return session;
      },
      vi.fn(),
      { pairing: { ...pairing, relay } },
    );
    link.start();
    await until(() => link.getSnapshot().route === "relay");
    desktop.close({ failure: "not-paired", code: 4003 });
    await until(() => link.getSnapshot().state.kind === "offline");
    expect(link.getSnapshot().state).toMatchObject({ failure: "not-paired", message: failureMessage("not-paired") });
    expect(link.getSnapshot().pairing.credential).toBe(pairing.credential);
    link.pause();
    await link.settled();
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
