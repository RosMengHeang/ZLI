import { useCallback, useEffect, useRef, useState } from "react";

import type { NotificationSettings, ZliBridge } from "../runtime/bridge.js";
import { buddyIcon } from "../teammates/buddyIcon.js";
import { hashedBuddy, storedChatBuddy } from "../teammates/chatBuddies.js";

/**
 * Connects the shell to the main process notifier: reports which agent tiles are on screen, selects
 * the agent when its notification is clicked, and reads and changes the notification settings.
 */
export function useAgentNotifications(
  bridge: ZliBridge | undefined,
  visibleSessionIds: readonly string[],
  onActivate: (sessionId: string) => void,
  /** The chats whose notifications show their buddy. */
  chatSessionIds: readonly string[] = [],
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

  // Each chat's notifications wear its buddy, the same one the sidebar shows.
  const chatsKey = JSON.stringify(chatSessionIds);
  useEffect(() => {
    const setFaces = notifications?.setFaces;
    if (!setFaces) return;
    let live = true;
    const ids = JSON.parse(chatsKey) as string[];
    void Promise.all(
      ids.map(async (id) => [id, await buddyIcon(storedChatBuddy(id) ?? hashedBuddy(id))] as const),
    ).then((pairs) => {
      if (!live) return;
      const faces: Record<string, string> = {};
      for (const [id, icon] of pairs) if (icon) faces[id] = icon;
      void setFaces(faces).catch(() => undefined);
    });
    return () => {
      live = false;
    };
  }, [notifications, chatsKey]);

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
