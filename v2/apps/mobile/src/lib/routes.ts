import {
  failureMessage,
  type RelayRoute,
  RemoteConnectError,
  type RemoteFailure,
  type RemoteSession,
  relayUrl,
  remoteUrl,
} from "@zli-v2/remote-protocol";

export type RouteKind = "lan" | "relay";
export type RouteResult = { session: RemoteSession; route: RouteKind; host?: string };

/** A wrong key or a forgotten phone will not get better on another route, so the race stops. */
export const blockingRouteFailures = new Set<RemoteFailure>(["not-paired", "handshake", "pairing-code"]);

/** Shown when every route failed and a relay was tried, so "same network" advice would be wrong. */
export const RELAY_UNREACHABLE_MESSAGE = "Your PC is not reachable. Check that it is on and connected to the internet.";

export const DEFAULT_LAN_HEAD_START_MS = 1_500;

export type RaceOptions = {
  lanHosts: string[];
  port: number;
  relay?: RelayRoute | undefined;
  /** Opens one encrypted session. It must close its socket when `signal` aborts. */
  open: (url: string, signal: AbortSignal) => Promise<RemoteSession>;
  lanHeadStartMs?: number;
  /** The route that worked last time. A relay win last time means the LAN is probably not there. */
  lastRoute?: RouteKind | undefined;
  /** Stops the whole race, for when the app leaves the screen mid-connect. */
  signal?: AbortSignal;
};

/**
 * Tries the LAN hosts in order and, after a short head start, the relay. The first completed
 * handshake wins and the other attempts are aborted; a session that finishes after that is closed.
 * The relay starts early when every LAN host has already failed.
 */
export function raceRoutes(options: RaceOptions): Promise<RouteResult> {
  const { lanHosts, port, relay, open, signal } = options;
  const headStart = options.lastRoute === "relay" ? 0 : (options.lanHeadStartMs ?? DEFAULT_LAN_HEAD_START_MS);

  return new Promise((resolve, reject) => {
    const attempts = new Set<AbortController>();
    const failures: RemoteConnectError[] = [];
    let settled = false;
    let lanDone = lanHosts.length === 0;
    let relayDone = relay === undefined;
    let relayStarted = false;
    let headStartTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (outcome: () => void, winner?: AbortController) => {
      if (settled) return;
      settled = true;
      clearTimeout(headStartTimer);
      for (const attempt of attempts) if (attempt !== winner) attempt.abort();
      outcome();
    };
    const rejectBest = () => {
      // A network failure says little; anything else tells the person more.
      const best = failures.find((failure) => failure.failure !== "network") ?? failures[0];
      finish(() => reject(best ?? new RemoteConnectError("network", failureMessage("network"))));
    };
    const checkAllFailed = () => {
      if (lanDone && relayDone && !settled) rejectBest();
    };

    /** Runs one attempt. True when it won. */
    const attempt = async (url: string, route: RouteKind, host?: string): Promise<boolean> => {
      if (settled) return false;
      const controller = new AbortController();
      attempts.add(controller);
      let session: RemoteSession;
      try {
        session = await open(url, controller.signal);
      } catch (error) {
        attempts.delete(controller);
        if (!(error instanceof RemoteConnectError)) {
          finish(() => reject(error));
        } else if (!settled) {
          failures.push(error);
          if (blockingRouteFailures.has(error.failure)) rejectBest();
        }
        return false;
      }
      attempts.delete(controller);
      if (settled) {
        session.transport.close();
        return false;
      }
      finish(() => resolve({ session, route, ...(host === undefined ? {} : { host }) }), controller);
      return true;
    };

    const startRelay = () => {
      if (!relay || relayStarted || settled) return;
      relayStarted = true;
      clearTimeout(headStartTimer);
      void attempt(relayUrl(relay, "phone"), "relay").then(() => {
        relayDone = true;
        checkAllFailed();
      });
    };

    if (signal?.aborted) {
      finish(() => reject(new RemoteConnectError("network", failureMessage("network"))));
      return;
    }
    signal?.addEventListener(
      "abort",
      () => finish(() => reject(new RemoteConnectError("network", failureMessage("network")))),
      { once: true },
    );

    if (lanHosts.length > 0) {
      void (async () => {
        for (const host of lanHosts) {
          if (await attempt(remoteUrl(host, port), "lan", host)) break;
          if (settled) break;
        }
        lanDone = true;
        // No LAN host answered, so waiting out the head start only delays the relay.
        startRelay();
        checkAllFailed();
      })();
    }
    if (relay) {
      if (lanHosts.length === 0 || headStart === 0) startRelay();
      else headStartTimer = setTimeout(startRelay, headStart);
    }
    checkAllFailed();
  });
}
