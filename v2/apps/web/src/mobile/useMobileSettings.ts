import type { MobileSettings } from "@zli-v2/contracts";
import { useCallback, useEffect, useState } from "react";

import type { MobileBridge } from "../runtime/bridge.js";
import { errorText } from "./mobile.js";

/** The Mobile panel and Settings both show the agent switch; a change in one updates the other. */
const listeners = new Set<(settings: MobileSettings) => void>();

function announce(settings: MobileSettings) {
  for (const listener of listeners) listener(settings);
}

export function useMobileSettings(mobile: MobileBridge | undefined): {
  settings: MobileSettings | undefined;
  error: string | undefined;
  setAgentTools(agentTools: boolean): void;
} {
  const [settings, setSettings] = useState<MobileSettings>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!mobile) return;
    let disposed = false;
    const listener = (next: MobileSettings) => {
      if (!disposed) setSettings(next);
    };
    listeners.add(listener);
    mobile.getSettings().then(listener, (cause: unknown) => {
      if (!disposed) setError(errorText(cause, "The agent setting could not be read."));
    });
    return () => {
      disposed = true;
      listeners.delete(listener);
    };
  }, [mobile]);

  const setAgentTools = useCallback(
    (agentTools: boolean) => {
      if (!mobile) return;
      setError(undefined);
      setSettings((current) => (current ? { ...current, agentTools } : current));
      mobile.setSettings({ agentTools }).then(announce, (cause: unknown) => {
        setError(errorText(cause, "The agent setting could not be saved."));
        void mobile.getSettings().then(announce, () => undefined);
      });
    },
    [mobile],
  );

  return { settings, error, setAgentTools };
}
