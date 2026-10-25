import type { MobileAccessStatus } from "@zli-v2/contracts";
import { useCallback, useEffect, useState } from "react";

import { getBridge } from "../runtime/bridge.js";

export type MobileAccessState =
  | { status: "unavailable" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; value: MobileAccessStatus };

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Phone access did not answer.";
}

/** Phone access status from the desktop, kept current by the status events main sends. */
export function useMobileAccess() {
  const api = getBridge()?.mobileAccess;
  const [state, setState] = useState<MobileAccessState>(api ? { status: "loading" } : { status: "unavailable" });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();

  const reload = useCallback(() => {
    if (!api) return;
    setState({ status: "loading" });
    api.getStatus().then(
      (value) => setState({ status: "ready", value }),
      (cause: unknown) => setState({ status: "error", message: message(cause) }),
    );
  }, [api]);

  useEffect(() => {
    if (!api) return;
    reload();
    return api.onStatus((value) => setState({ status: "ready", value }));
  }, [api, reload]);

  const run = useCallback(async (work: () => Promise<MobileAccessStatus> | undefined) => {
    setBusy(true);
    setActionError(undefined);
    try {
      const value = await work();
      if (value) setState({ status: "ready", value });
    } catch (cause) {
      setActionError(message(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  return {
    state,
    busy,
    actionError,
    reload,
    setEnabled: (enabled: boolean) => run(() => api?.setEnabled(enabled)),
    startPairing: () => run(() => api?.startPairing()),
    cancelPairing: () => run(() => api?.cancelPairing()),
    revoke: (deviceId: string) => run(() => api?.revoke(deviceId)),
  };
}
