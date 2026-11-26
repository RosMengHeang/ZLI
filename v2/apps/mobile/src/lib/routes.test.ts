import {
  failureMessage,
  type RelayRoute,
  RemoteConnectError,
  type RemoteFailure,
  type RemoteSession,
} from "@zli-v2/remote-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { raceRoutes } from "./routes.js";

const relay: RelayRoute = { url: "wss://relay.example.com", room: "R".repeat(21) + "A" };
const relayUrlText = `wss://relay.example.com/v1/phone/${relay.room}`;

type Fake = { session: RemoteSession; closed: () => boolean };
function fakeSession(): Fake {
  let closed = false;
  const session = {
    transport: {
      close: () => {
        closed = true;
      },
      send() {},
      onMessage: () => () => {},
      onClose: () => () => {},
    },
    ready: {},
  } as unknown as RemoteSession;
  return { session, closed: () => closed };
}
const fail = (failure: RemoteFailure) => new RemoteConnectError(failure, failureMessage(failure));

/** Resolves or rejects after `ms`, unless aborted first (then rejects with network, like the real client). */
function after(ms: number, outcome: Fake | RemoteConnectError, signal: AbortSignal): Promise<RemoteSession> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (outcome instanceof RemoteConnectError) reject(outcome);
      else resolve(outcome.session);
    }, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(fail("network"));
    });
  });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("raceRoutes", () => {
  it("never starts the relay when LAN answers within the head start", async () => {
    const lan = fakeSession();
    const urls: string[] = [];
    const result = raceRoutes({
      lanHosts: ["192.168.1.20"],
      port: 47321,
      relay,
      open: (url, signal) => {
        urls.push(url);
        return after(200, lan, signal);
      },
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(result).resolves.toMatchObject({ route: "lan", host: "192.168.1.20", session: lan.session });
    expect(urls).toEqual(["ws://192.168.1.20:47321/remote"]);
  });

  it("falls to the relay when LAN stalls, and aborts the LAN attempt", async () => {
    const relaySession = fakeSession();
    const aborted: string[] = [];
    const result = raceRoutes({
      lanHosts: ["192.168.1.20"],
      port: 47321,
      relay,
      open: (url, signal) => {
        if (url.startsWith("wss://")) return after(300, relaySession, signal);
        signal.addEventListener("abort", () => aborted.push(url));
        return new Promise(() => {});
      },
    });
    await vi.advanceTimersByTimeAsync(1_500 + 300);
    await expect(result).resolves.toMatchObject({ route: "relay", session: relaySession.session });
    expect(aborted).toEqual(["ws://192.168.1.20:47321/remote"]);
  });

  it("starts the relay at once when every LAN host fails fast", async () => {
    const relaySession = fakeSession();
    const result = raceRoutes({
      lanHosts: ["a", "b"],
      port: 1,
      relay,
      open: (url, signal) =>
        url.startsWith("wss://") ? after(10, relaySession, signal) : after(20, fail("network"), signal),
    });
    // LAN fails at 20 and 40 ms, relay finishes at 50 ms: far under the 1500 ms head start.
    await vi.advanceTimersByTimeAsync(60);
    await expect(result).resolves.toMatchObject({ route: "relay" });
  });

  it("closes a LAN session that completes after the relay won", async () => {
    const lan = fakeSession();
    const relaySession = fakeSession();
    const result = raceRoutes({
      lanHosts: ["a"],
      port: 1,
      relay,
      open: (url, signal) =>
        url.startsWith("wss://")
          ? after(100, relaySession, signal)
          : // Ignores the abort, like a handshake that finished in the same tick.
            new Promise((resolve) => setTimeout(() => resolve(lan.session), 1_700)),
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(result).resolves.toMatchObject({ route: "relay" });
    expect(lan.closed()).toBe(true);
    expect(relaySession.closed()).toBe(false);
  });

  it("ends at once on a blocking failure, preferring it over network", async () => {
    const result = raceRoutes({
      lanHosts: ["a"],
      port: 1,
      relay,
      open: (url, signal) =>
        url.startsWith("wss://") ? after(10, fail("handshake"), signal) : after(5_000, fail("network"), signal),
    });
    const settled = expect(result).rejects.toMatchObject({ failure: "handshake" });
    await vi.advanceTimersByTimeAsync(1_600);
    await settled;
  });

  it("rejects with the non-network failure when everything fails", async () => {
    const result = raceRoutes({
      lanHosts: ["a"],
      port: 1,
      relay,
      open: (url, signal) =>
        url.startsWith("wss://") ? after(10, fail("unavailable"), signal) : after(5, fail("network"), signal),
    });
    const settled = expect(result).rejects.toMatchObject({ failure: "unavailable" });
    await vi.advanceTimersByTimeAsync(100);
    await settled;
  });

  it("behaves like today without a relay: hosts in order, last network failure", async () => {
    const urls: string[] = [];
    const result = raceRoutes({
      lanHosts: ["a", "b"],
      port: 1,
      open: (url, signal) => {
        urls.push(url);
        return after(10, fail("network"), signal);
      },
    });
    const settled = expect(result).rejects.toMatchObject({ failure: "network" });
    await vi.advanceTimersByTimeAsync(100);
    await settled;
    expect(urls).toEqual(["ws://a:1/remote", "ws://b:1/remote"]);
  });

  it("skips the head start when the relay won last time", async () => {
    const urls: string[] = [];
    void raceRoutes({
      lanHosts: ["a"],
      port: 1,
      relay,
      lastRoute: "relay",
      open: (url) => {
        urls.push(url);
        return new Promise(() => {});
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(urls).toEqual(["ws://a:1/remote", relayUrlText]);
  });

  it("goes straight to the relay when there are no LAN hosts", async () => {
    const urls: string[] = [];
    void raceRoutes({
      lanHosts: [],
      port: 1,
      relay,
      open: (url) => {
        urls.push(url);
        return new Promise(() => {});
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(urls).toEqual([relayUrlText]);
  });

  it("stops everything when the caller aborts", async () => {
    const controller = new AbortController();
    const seen: AbortSignal[] = [];
    const result = raceRoutes({
      lanHosts: ["a"],
      port: 1,
      relay,
      signal: controller.signal,
      open: (_url, signal) => {
        seen.push(signal);
        return after(10_000, fail("network"), signal);
      },
    });
    const settled = expect(result).rejects.toBeInstanceOf(RemoteConnectError);
    controller.abort();
    await settled;
    expect(seen.every((signal) => signal.aborted)).toBe(true);
  });
});
