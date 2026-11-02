import * as Notifications from "expo-notifications";
import { useEffect, useRef, useState } from "react";
import { AppState, Linking, Platform } from "react-native";

import { useLink } from "./LinkContext.js";
import { type AgentAlert, agentAlerts, answeredAlertKeys, shouldShowAlert } from "./lib/alerts.js";

const CHANNEL_ID = "agents";

/** What the phone lets this app do: `blocked` means only the system settings can turn it back on. */
export type NotificationAccess = "on" | "off" | "blocked";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

let channelReady: Promise<unknown> | undefined;

function ensureChannel(): Promise<unknown> {
  if (Platform.OS !== "android") return Promise.resolve();
  channelReady ??= Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: "Agents",
    description: "Approvals, questions, and agents that finish, fail, or stop.",
    importance: Notifications.AndroidImportance.HIGH,
  }).catch(() => {
    channelReady = undefined;
  });
  return channelReady;
}

function accessOf(permission: Notifications.NotificationPermissionsStatus): NotificationAccess {
  const provisional = permission.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
  if (permission.granted || provisional) return "on";
  return permission.canAskAgain ? "off" : "blocked";
}

export async function notificationAccess(): Promise<NotificationAccess> {
  return accessOf(await Notifications.getPermissionsAsync());
}

export async function askForNotifications(): Promise<NotificationAccess> {
  await ensureChannel();
  return accessOf(await Notifications.requestPermissionsAsync());
}

/** Asks once, on the first launch after pairing. Later changes happen in Settings or the system settings. */
export async function askForNotificationsOnce(): Promise<void> {
  const permission = await Notifications.getPermissionsAsync();
  if (permission.status === "undetermined" && permission.canAskAgain) await askForNotifications();
}

export function openSystemSettings(): void {
  void Linking.openSettings().catch(() => {});
}

async function show(alert: AgentAlert): Promise<void> {
  await ensureChannel();
  const urgent = alert.kind === "approval" || alert.kind === "question" || alert.kind === "failed";
  await Notifications.scheduleNotificationAsync({
    identifier: alert.key,
    content: { title: alert.title, body: alert.body, data: { threadId: alert.threadId }, sound: urgent },
    trigger: Platform.OS === "android" ? { channelId: CHANNEL_ID } : null,
  });
}

/** A one-off message, such as a lock screen answer that did not reach the desktop. */
export async function showNotice(title: string, body: string): Promise<void> {
  await ensureChannel();
  await Notifications.scheduleNotificationAsync({
    content: { title, body },
    trigger: Platform.OS === "android" ? { channelId: CHANNEL_ID } : null,
  });
}

/** Turns changes in the desktop's projection into notifications for as long as it is mounted. */
export function useAgentAlerts(openThreadId: string | undefined): void {
  const link = useLink();
  const open = useRef(openThreadId);
  open.current = openThreadId;

  useEffect(() => {
    let previous = link.getSnapshot().projection;
    return link.subscribe(() => {
      const next = link.getSnapshot().projection;
      if (!next || next === previous) return;
      const before = previous;
      previous = next;
      for (const key of answeredAlertKeys(before, next)) {
        void Notifications.dismissNotificationAsync(key).catch(() => {});
      }
      const context = { active: AppState.currentState === "active", openThreadId: open.current };
      for (const alert of agentAlerts(before, next)) {
        // A refused permission makes scheduling fail; the app works the same without alerts.
        if (shouldShowAlert(alert, context)) void show(alert).catch(() => {});
      }
    });
  }, [link]);
}

function threadOf(response: Notifications.NotificationResponse | null): string | undefined {
  const threadId = response?.notification.request.content.data?.threadId;
  return typeof threadId === "string" ? threadId : undefined;
}

/** Calls `onOpen` with the agent of a tapped notification, including the one that launched the app. */
export function useNotificationTaps(onOpen: (threadId: string) => void): void {
  const handler = useRef(onOpen);
  handler.current = onOpen;

  useEffect(() => {
    const launched = threadOf(Notifications.getLastNotificationResponse());
    if (launched) {
      Notifications.clearLastNotificationResponse();
      handler.current(launched);
    }
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      const threadId = threadOf(response);
      if (threadId) handler.current(threadId);
    });
    return () => subscription.remove();
  }, []);
}

/** The current permission, refreshed when the person comes back from the system settings. */
export function useNotificationAccess(): [NotificationAccess | undefined, () => Promise<void>] {
  const [access, setAccess] = useState<NotificationAccess>();

  useEffect(() => {
    const refresh = () => void notificationAccess().then(setAccess, () => {});
    refresh();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    return () => subscription.remove();
  }, []);

  const ask = async () => {
    setAccess(await askForNotifications().catch(() => "blocked" as const));
  };
  return [access, ask];
}
