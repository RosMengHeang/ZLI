import { encodePairingCode, RelayRoute, roomIdFromSecret, toBase64Url } from "@zli-v2/remote-protocol";

import type { MobileAccessStore } from "./MobileAccessStore.js";
import type { MobileGateway } from "./MobileGateway.js";
import type { RelayState } from "./RelayHost.js";

/** The relay URL this build ships with, from ZLI_RELAY_URL. Anything that is not a plain wss:// URL counts as none. */
export function relayUrlFrom(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = RelayRoute.shape.url.safeParse(value.trim());
  return parsed.success ? parsed.data : undefined;
}

/** The text of a pairing code. It carries the relay route only when the caller passes one. */
export function desktopPairingCode(input: {
  name: string;
  hosts: string[];
  port: number;
  key: string;
  pending: { pairingId: string; secret: Uint8Array; expiresAt: number };
  relay?: RelayRoute;
}): string {
  return encodePairingCode({
    v: 1,
    name: input.name,
    hosts: input.hosts,
    port: input.port,
    key: input.key,
    pairingId: input.pending.pairingId,
    secret: toBase64Url(input.pending.secret),
    expiresAt: input.pending.expiresAt,
    ...(input.relay ? { relay: input.relay } : {}),
  });
}

interface RunningHost {
  start(): void;
  stop(): void;
}

export interface RelayLinkOptions {
  /** Undefined when this build has no relay set up. */
  readonly url: string | undefined;
  readonly store: Pick<MobileAccessStore, "relay" | "relaySecret">;
  readonly gateway: Pick<MobileGateway, "listening">;
  readonly createHost: (options: {
    route: RelayRoute;
    secret: Uint8Array;
    onState: (state: RelayState) => void;
  }) => RunningHost;
  readonly onChange: () => void;
}

/**
 * Keeps one relay host running while the relay is on, the gateway listens, and the build has a relay URL, and none
 * otherwise. Call sync() after any of those changes.
 */
export class RelayLink {
  readonly #options: RelayLinkOptions;
  #host: RunningHost | undefined;
  #room: string | undefined;
  #state: RelayState = "off";

  constructor(options: RelayLinkOptions) {
    this.#options = options;
  }

  get available(): boolean {
    return this.#options.url !== undefined;
  }

  get state(): RelayState {
    return this.#state;
  }

  /** Where phones find this desktop through the relay, while the relay is on. */
  route(): RelayRoute | undefined {
    const { url, store } = this.#options;
    if (!url || !store.relay.enabled) return undefined;
    const secret = store.relaySecret();
    return secret ? { url, room: roomIdFromSecret(secret) } : undefined;
  }

  sync(): void {
    const route = this.#options.gateway.listening ? this.route() : undefined;
    if (route && this.#host && this.#room === route.room) return;
    this.stop();
    const secret = this.#options.store.relaySecret();
    if (!route || !secret) return;
    const host: RunningHost = this.#options.createHost({
      route,
      secret,
      onState: (state) => {
        // A host that was stopped still reports "off" on its way out.
        if (this.#host !== host) return;
        this.#setState(state);
      },
    });
    this.#host = host;
    this.#room = route.room;
    host.start();
  }

  /** Dials the relay again with the same room, for example to take the room back from another PC. */
  retry(): void {
    const host = this.#host;
    if (!host) return;
    host.stop();
    host.start();
  }

  stop(): void {
    const host = this.#host;
    this.#host = undefined;
    this.#room = undefined;
    host?.stop();
    this.#setState("off");
  }

  #setState(state: RelayState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#options.onChange();
  }
}
