import type { DeviceAppearance, DeviceNotification, DevicePermission, DeviceTextSize } from "@zli-v2/contracts";

/** Android's font_scale for each text size step. */
export const ANDROID_FONT_SCALES: Record<DeviceTextSize, string> = {
  small: "0.85",
  default: "1.0",
  large: "1.15",
  largest: "1.3",
};

/** simctl's content_size for each text size step. Large is iOS's own default. */
export const IOS_CONTENT_SIZES: Record<DeviceTextSize, string> = {
  small: "small",
  default: "large",
  large: "extra-large",
  largest: "extra-extra-extra-large",
};

/**
 * The Android permissions behind each kind. Android versions name photo access differently and apps declare
 * only some of them, so every name is tried and the ones the app does not declare are skipped.
 */
export const ANDROID_PERMISSIONS: Record<DevicePermission, readonly string[]> = {
  camera: ["android.permission.CAMERA"],
  location: ["android.permission.ACCESS_FINE_LOCATION", "android.permission.ACCESS_COARSE_LOCATION"],
  photos: ["android.permission.READ_MEDIA_IMAGES", "android.permission.READ_EXTERNAL_STORAGE"],
  microphone: ["android.permission.RECORD_AUDIO"],
  notifications: ["android.permission.POST_NOTIFICATIONS"],
  contacts: ["android.permission.READ_CONTACTS", "android.permission.WRITE_CONTACTS"],
};

/** simctl privacy services. Camera and notifications have none. */
export const IOS_PRIVACY_SERVICES: Partial<Record<DevicePermission, string>> = {
  location: "location",
  photos: "photos",
  microphone: "microphone",
  contacts: "contacts",
};

/** `cmd uimode night` answers "Night mode: yes", "no", "auto", or "custom". */
export function parseNightMode(output: string): DeviceAppearance | undefined {
  const value = /Night mode:\s*(\w+)/iu.exec(output)?.[1]?.toLowerCase();
  return value === "yes" ? "dark" : value === "no" ? "light" : undefined;
}

/** `settings get system font_scale` answers a number, or "null" when it was never changed. */
export function parseFontScale(output: string): DeviceTextSize | undefined {
  const text = output.trim();
  if (text === "null") return "default";
  const scale = Number(text);
  if (!text || !Number.isFinite(scale)) return undefined;
  return (Object.keys(ANDROID_FONT_SCALES) as DeviceTextSize[]).find(
    (size) => Math.abs(Number(ANDROID_FONT_SCALES[size]) - scale) < 0.001,
  );
}

export function parseIosAppearance(output: string): DeviceAppearance | undefined {
  const value = output.trim().toLowerCase();
  return value === "light" || value === "dark" ? value : undefined;
}

export function parseIosContentSize(output: string): DeviceTextSize | undefined {
  const value = output.trim().toLowerCase();
  return (Object.keys(IOS_CONTENT_SIZES) as DeviceTextSize[]).find((size) => IOS_CONTENT_SIZES[size] === value);
}

/** A coordinate as plain decimal text, never in exponent form, to six places (about 10 cm). */
export function coordinate(value: number): string {
  return String(Number(value.toFixed(6)));
}

/** The APNs payload simctl push reads. */
export function pushPayload(notification: DeviceNotification): string {
  return JSON.stringify({
    aps: {
      alert: {
        ...(notification.title ? { title: notification.title } : {}),
        ...(notification.body ? { body: notification.body } : {}),
      },
      sound: "default",
    },
  });
}

export type AndroidPermissionFailure = "not-requested" | "unknown-permission" | "not-installed" | "other";

/** Sorts what `pm grant` or `pm revoke` printed when it failed. */
export function androidPermissionFailure(output: string): AndroidPermissionFailure {
  if (/has not requested permission/iu.test(output)) return "not-requested";
  if (/Unknown permission/iu.test(output)) return "unknown-permission";
  if (/Unknown package|NameNotFoundException|package .* (?:not found|does not exist)/iu.test(output))
    return "not-installed";
  return "other";
}
