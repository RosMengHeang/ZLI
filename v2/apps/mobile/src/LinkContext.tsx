import { createContext, type ReactNode, useContext, useEffect, useState, useSyncExternalStore } from "react";
import { AppState } from "react-native";

import { type LinkSnapshot, RemoteLink } from "./lib/link.js";
import type { StoredPairing } from "./lib/pairingRecord.js";
import { createSocket, newId, random, savePairing } from "./platform.js";

const LinkContext = createContext<RemoteLink | undefined>(undefined);

/** Owns the connection for one pairing. Mount it with `key={pairing.deviceId}`. */
export function LinkProvider({ pairing, children }: { pairing: StoredPairing; children: ReactNode }) {
  const [link] = useState(
    () =>
      new RemoteLink({
        pairing,
        random,
        createSocket,
        newId,
        // A failed write only means the next launch tries the older addresses first.
        onPairingChange: (next) => void savePairing(next).catch(() => {}),
      }),
  );

  useEffect(() => {
    link.start();
    // Phones suspend background sockets anyway; closing first avoids a long wait on a dead one.
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") link.start();
      else if (state === "background") link.pause();
    });
    return () => {
      subscription.remove();
      link.pause();
    };
  }, [link]);

  return <LinkContext.Provider value={link}>{children}</LinkContext.Provider>;
}

export function useLink(): RemoteLink {
  const link = useContext(LinkContext);
  if (!link) throw new Error("useLink needs a LinkProvider");
  return link;
}

export function useLinkSnapshot(): LinkSnapshot {
  const link = useLink();
  return useSyncExternalStore(link.subscribe, link.getSnapshot);
}

/** "Connected", or what the link is doing instead, for headers. Counts down while offline. */
export function useConnectionLabel(): string {
  const snapshot = useLinkSnapshot();
  const [now, setNow] = useState(Date.now);
  const offline = snapshot.state.kind === "offline";
  useEffect(() => {
    if (!offline) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [offline]);
  return connectionLabel(snapshot, now);
}

function connectionLabel(snapshot: LinkSnapshot, now: number): string {
  const { state } = snapshot;
  switch (state.kind) {
    case "online":
      return "Connected";
    case "connecting":
      return state.attempt === 0 && snapshot.generation === 0 ? "Connecting…" : "Reconnecting…";
    case "offline": {
      const seconds = Math.max(1, Math.round((state.retryAt - now) / 1000));
      return `Offline, trying again in ${seconds} s`;
    }
    case "blocked":
      return "Not paired";
    case "paused":
      return "Paused";
  }
}
