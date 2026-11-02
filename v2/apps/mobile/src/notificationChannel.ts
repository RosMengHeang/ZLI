import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

/** The Android channel for agent alerts, posted by the app and by push notifications from the desktop. */
export const CHANNEL_ID = "agents";

let channelReady: Promise<unknown> | undefined;

export function ensureChannel(): Promise<unknown> {
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
