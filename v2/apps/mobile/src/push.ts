import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import { easProjectId, type PushRegistration } from "./lib/push.js";
import { ensureChannel } from "./notificationChannel.js";

/**
 * The Expo push token the desktop sends alerts to while the app is not connected. Undefined when
 * this build cannot get one: no EAS project yet, or a simulator or emulator.
 */
export async function pushRegistration(): Promise<PushRegistration | undefined> {
  const platform = Platform.OS;
  if (platform !== "ios" && platform !== "android") return undefined;
  const projectId = easProjectId(Constants.expoConfig, Constants.easConfig);
  if (!projectId || !Device.isDevice) return undefined;
  const permission = await Notifications.getPermissionsAsync();
  const allowed = permission.granted || permission.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
  if (!allowed) return { token: null, platform };
  // Pushes name this channel, which has to exist before the first one arrives.
  await ensureChannel();
  const token = await Notifications.getExpoPushTokenAsync({ projectId });
  return { token: token.data, platform };
}
