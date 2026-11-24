import { useEffect, useId, useState } from "react";

import { getBridge, type PresenceStatus, type ZliBridge } from "../runtime/bridge.js";
import { Icon } from "../ui/Icon.js";
import { SettingsGroup, SettingsRow } from "./SettingsLayout.js";

type SecurityBridge = NonNullable<ZliBridge["security"]>;

const DESCRIPTION =
  "ZLI asks for Windows Hello once each time it opens, before buddies can use the Composio key. Without it, any program running as you can read the key from disk.";

/** "Unlock connected apps with Windows Hello". Shown only in the desktop app on Windows. */
export function ConnectedAppsLock({ security = getBridge()?.security }: { security?: SecurityBridge | undefined }) {
  const id = useId();
  const [state, setState] = useState<PresenceStatus>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!security) return;
    let live = true;
    security.presenceStatus().then(
      (next) => live && setState(next),
      () => live && setState({ status: "unsupported" }),
    );
    return () => {
      live = false;
    };
  }, [security]);

  if (!security || !state || state.status === "unsupported") return null;

  const toggle = async (on: boolean) => {
    setBusy(true);
    try {
      setState(await (on ? security.turnOnPresence() : security.turnOffPresence()));
    } catch (error) {
      setState({ ...state, error: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  const unavailable = state.status === "unavailable";
  return (
    <SettingsGroup title="Connected apps">
      <SettingsRow
        label="Unlock connected apps with Windows Hello"
        description={unavailable ? "Set up Windows Hello in Windows Settings to use this." : DESCRIPTION}
        descriptionTone={unavailable ? "warning" : undefined}
        htmlFor={id}
      >
        <input
          id={id}
          className="switch"
          type="checkbox"
          role="switch"
          checked={state.status === "on"}
          aria-checked={state.status === "on"}
          disabled={unavailable || busy}
          onChange={(event) => void toggle(event.target.checked)}
        />
      </SettingsRow>
      {state.error ? (
        <p className="inline-error" role="alert">
          <Icon name="alert" size={13} />
          {state.error}
        </p>
      ) : null}
    </SettingsGroup>
  );
}
