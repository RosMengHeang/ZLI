import type { RuntimeProjection } from "@zli-v2/contracts";
import { useEffect, useRef } from "react";
import { AppState, Linking } from "react-native";

import { useLink } from "./LinkContext.js";
import { sendCommand } from "./lib/launch.js";
import type { RemoteLink } from "./lib/link.js";
import { agentFromLink, liveCommand, liveStatus } from "./lib/liveStatus.js";
import { liveDisplay } from "./liveDisplay.js";
import { showNotice } from "./notifications.js";

const CONNECT_TIMEOUT_MS = 15_000;
/** Long enough for the desktop's next projection to reach the activity before iOS suspends the app. */
const SETTLE_MS = 3_000;

/** The projection once the link is online, connecting first when a button press woke the app. */
function onlineProjection(link: RemoteLink): Promise<RuntimeProjection | undefined> {
  return new Promise((resolve) => {
    let stop: () => void = () => {};
    const timer = setTimeout(() => finish(undefined), CONNECT_TIMEOUT_MS);
    function finish(projection: RuntimeProjection | undefined) {
      clearTimeout(timer);
      stop();
      resolve(projection);
    }
    function check() {
      const { state, projection } = link.getSnapshot();
      if (state.kind === "online") finish(projection);
      else if (state.kind === "blocked") finish(undefined);
    }
    stop = link.subscribe(check);
    if (link.getSnapshot().state.kind !== "online") link.start();
    check();
  });
}

async function press(link: RemoteLink, target: string): Promise<void> {
  const desktop = link.getSnapshot().pairing.desktopName;
  const projection = await onlineProjection(link);
  if (!projection) {
    await showNotice(`Could not reach ${desktop}`, "Open ZLI Remote to try again.");
    return;
  }
  // Already answered or stopped, on the desktop or in the app.
  const command = liveCommand(projection, target);
  if (!command) return;
  const outcome = await sendCommand(link, command, `The answer did not reach ${desktop}.`);
  if (!outcome.ok) await showNotice("That did not go through", outcome.error);
}

/**
 * Keeps the lock screen, Dynamic Island, or Android notification in step with the desktop, runs the
 * buttons pressed there, and opens the agent when the status itself is tapped.
 */
export function useLiveStatus(onOpen: (threadId: string) => void): void {
  const link = useLink();
  const open = useRef(onOpen);
  open.current = onOpen;

  useEffect(() => {
    // Unknown at launch: an activity from before may still be up and has to go if nothing is live.
    let shown: string | undefined = "";
    const render = () => {
      const snapshot = link.getSnapshot();
      if (!snapshot.projection && snapshot.state.kind !== "blocked") return;
      const background = AppState.currentState !== "active";
      const status = snapshot.state.kind === "blocked" ? undefined : liveStatus(snapshot.projection);
      if (!status) {
        if (shown !== undefined) void liveDisplay.hide().catch(() => {});
        shown = undefined;
        // Nothing left to follow, so the open connection would only cost battery.
        if (background && liveDisplay.keepsAppRunning) link.pause();
        return;
      }
      const key = JSON.stringify([status, background]);
      if (key === shown) return;
      shown = key;
      void liveDisplay.show(status, { background }).catch(() => {});
    };
    render();
    const stopLink = link.subscribe(render);
    const appState = AppState.addEventListener("change", render);
    return () => {
      stopLink();
      appState.remove();
      if (shown !== undefined) void liveDisplay.hide().catch(() => {});
    };
  }, [link]);

  useEffect(() => {
    const subscription = liveDisplay.onAction((target) => {
      void press(link, target)
        .catch(() => {})
        .finally(() => {
          setTimeout(() => {
            // A press from the lock screen woke the app; on iOS the connection would die with it.
            if (AppState.currentState !== "active" && !liveDisplay.keepsAppRunning) link.pause();
          }, SETTLE_MS);
        });
    });
    return () => subscription.remove();
  }, [link]);

  useEffect(() => {
    const openLink = (url: string | null | undefined) => {
      const threadId = agentFromLink(url);
      if (threadId) open.current(threadId);
    };
    void Linking.getInitialURL().then(openLink, () => {});
    const subscription = Linking.addEventListener("url", (event) => openLink(event.url));
    return () => subscription.remove();
  }, []);
}
