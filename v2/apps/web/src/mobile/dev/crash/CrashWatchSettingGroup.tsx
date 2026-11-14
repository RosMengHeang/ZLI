import { useCallback, useEffect, useState } from "react";

import type { MobileBridge } from "../../../runtime/bridge.js";
import { SettingsGroup } from "../../../settings/SettingsLayout.js";
import { Switch } from "../../../ui/Switch.js";
import { errorText } from "../../mobile.js";

const HINT =
  "While a device runs, ZLI reads its log for crashes and tells the agent using it. Nothing goes into a chat unless you choose Send to agent.";

/** Settings > Mobile: whether ZLI reads device logs for crashes. */
export function CrashWatchSettingGroup({ mobile }: { mobile: MobileBridge }) {
  const [crashWatch, setCrashWatch] = useState<boolean>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let current = true;
    mobile.getSettings().then(
      (settings) => {
        if (current) setCrashWatch(settings.crashWatch);
      },
      (cause: unknown) => {
        if (current) setError(errorText(cause, "The crash watch setting could not be read."));
      },
    );
    return () => {
      current = false;
    };
  }, [mobile]);

  const change = useCallback(
    (next: boolean) => {
      setError(undefined);
      setCrashWatch(next);
      mobile.setSettings({ crashWatch: next }).then(
        (settings) => setCrashWatch(settings.crashWatch),
        (cause: unknown) => {
          setError(errorText(cause, "The crash watch setting could not be saved."));
          void mobile.getSettings().then(
            (settings) => setCrashWatch(settings.crashWatch),
            () => undefined,
          );
        },
      );
    },
    [mobile],
  );

  return (
    <SettingsGroup title="Crash watch">
      <Switch
        label="Watch for crashes"
        hint={error ?? HINT}
        checked={crashWatch ?? false}
        disabled={crashWatch === undefined}
        onChange={change}
      />
    </SettingsGroup>
  );
}
