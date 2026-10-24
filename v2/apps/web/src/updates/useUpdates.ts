import type { UpdateStatus, WhatsNew } from "@zli-v2/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { ZliBridge } from "../runtime/bridge.js";

type UpdatesBridge = NonNullable<ZliBridge["updates"]>;

/** The desktop app's update state and controls. Everything is a no-op outside the desktop app. */
export function useUpdates(bridge: ZliBridge | undefined) {
  const updates = bridge?.updates;
  const [status, setStatus] = useState<UpdateStatus>();
  const [whatsNew, setWhatsNew] = useState<WhatsNew>();

  useEffect(() => {
    if (!updates) return;
    let active = true;
    const off = updates.onStatus((next) => {
      if (active) setStatus(next);
    });
    void updates
      .getStatus()
      // A status pushed while the request was in flight is newer than its answer.
      .then((value) => active && setStatus((current) => current ?? value))
      .catch(() => undefined);
    void updates
      .whatsNew()
      .then((value) => active && value && setWhatsNew(value))
      .catch(() => undefined);
    return () => {
      active = false;
      off();
    };
  }, [updates]);

  const run = useCallback(
    async (action: (bridge: UpdatesBridge) => Promise<UpdateStatus>) => {
      if (!updates) return;
      try {
        setStatus(await action(updates));
      } catch {
        // Main reports update failures in the status itself.
      }
    },
    [updates],
  );

  return useMemo(
    () => ({
      available: updates !== undefined,
      status,
      whatsNew,
      check: () => run((target) => target.check()),
      download: () => run((target) => target.download()),
      setAutoInstall: (autoInstall: boolean) => run((target) => target.setAutoInstall(autoInstall)),
      install: async () => (await updates?.quitAndInstall().catch(() => false)) ?? false,
      openReleasePage: () => updates?.openReleasePage().catch(() => undefined),
      dismissWhatsNew: () => {
        setWhatsNew(undefined);
        void updates?.dismissWhatsNew().catch(() => undefined);
      },
    }),
    [run, status, updates, whatsNew],
  );
}

export type Updates = ReturnType<typeof useUpdates>;
