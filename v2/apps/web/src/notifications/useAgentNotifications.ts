import { useCallback, useEffect, useRef, useState } from "react";

import type { NotificationSettings, ZliBridge } from "../runtime/bridge.js";

/**
 * Connects the shell to the main process notifier: reports which agent tiles are on screen, selects
 * the agent when its notification is clicked, and reads and changes the notification settings.
 */
export function useAgentNotifications(
  bridge: ZliBridge | undefined,
  visibleSessionIds: readonly string[],
  onActivate: (sessionId: string) => void,
) {
  const notifications = bridge?.notifications;
  const [settings, setSettings] = useState<NotificationSettings>();
  useEffect(() => {
    if (!notifications) return;
    let active = true;
    void notifications
      .getSettings()
      .then((value) => {
        if (active) setSettings(value);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [notifications]);

  const visibleKey = JSON.stringify(visibleSessionIds);
  useEffect(() => {
    void notifications?.setViewing(JSON.parse(visibleKey) as string[]).catch(() => undefined);
  }, [notifications, visibleKey]);

  const activateRef = useRef(onActivate);
  activateRef.current = onActivate;
  useEffect(() => notifications?.onActivate(({ sessionId }) => activateRef.current(sessionId)), [notifications]);

  const update = useCallback(
    async (patch: Partial<NotificationSettings>) => {
      if (!notifications) return;
      setSettings(await notifications.setSettings(patch));
    },
    [notifications],
  );
  return { settings, update };
}
