import { z } from "zod";

import { MobileControlDeviceInput, type MobileDevice, MobileDeviceIdInput } from "./mobile.js";

export const DeviceAppearance = z.enum(["light", "dark"]);
export type DeviceAppearance = z.infer<typeof DeviceAppearance>;

export const DeviceTextSize = z.enum(["small", "default", "large", "largest"]);
export type DeviceTextSize = z.infer<typeof DeviceTextSize>;

export const DEVICE_TEXT_SIZE_LABELS: Record<DeviceTextSize, string> = {
  small: "Small",
  default: "Default",
  large: "Large",
  largest: "Largest",
};

export const DEVICE_PERMISSIONS = ["camera", "location", "photos", "microphone", "notifications", "contacts"] as const;
export const DevicePermission = z.enum(DEVICE_PERMISSIONS);
export type DevicePermission = z.infer<typeof DevicePermission>;

export const DEVICE_PERMISSION_LABELS: Record<DevicePermission, string> = {
  camera: "Camera",
  location: "Location",
  photos: "Photos",
  microphone: "Microphone",
  notifications: "Notifications",
  contacts: "Contacts",
};

/**
 * An Android package name or iOS bundle id. It is passed to adb shell and simctl, so it must start with a letter
 * and holds only letters, digits, dots, underscores, and hyphens.
 */
export const DeviceAppId = z
  .string()
  .trim()
  .min(3)
  .max(255)
  .regex(/^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)+$/u, "Use an app id such as com.example.app.");

export const Latitude = z.number().min(-90, "Latitude goes from -90 to 90.").max(90, "Latitude goes from -90 to 90.");
export const Longitude = z
  .number()
  .min(-180, "Longitude goes from -180 to 180.")
  .max(180, "Longitude goes from -180 to 180.");

export const DeviceLocation = z.object({ latitude: Latitude, longitude: Longitude });
export type DeviceLocation = z.infer<typeof DeviceLocation>;

const NotificationTitle = z.string().trim().max(120);
const NotificationBody = z.string().trim().max(500);

export const DeviceNotification = z
  .object({ title: NotificationTitle, body: NotificationBody })
  .refine((notification) => notification.title !== "" || notification.body !== "", {
    message: "Give the notification a title or a body.",
  });
export type DeviceNotification = z.infer<typeof DeviceNotification>;

/** What ZLI could read back from the device. A field is missing when the device did not say. */
export const DeviceConditions = z.object({
  appearance: DeviceAppearance.optional(),
  textSize: DeviceTextSize.optional(),
});
export type DeviceConditions = z.infer<typeof DeviceConditions>;

export const MobileAppearanceInput = MobileDeviceIdInput.extend({ appearance: DeviceAppearance });
export type MobileAppearanceInput = z.infer<typeof MobileAppearanceInput>;

export const MobileTextSizeInput = MobileDeviceIdInput.extend({ textSize: DeviceTextSize });
export type MobileTextSizeInput = z.infer<typeof MobileTextSizeInput>;

export const MobileLocationInput = MobileDeviceIdInput.extend({ latitude: Latitude, longitude: Longitude });
export type MobileLocationInput = z.infer<typeof MobileLocationInput>;

export const MobilePermissionInput = MobileDeviceIdInput.extend({
  appId: DeviceAppId,
  permission: DevicePermission,
  grant: z.boolean(),
});
export type MobilePermissionInput = z.infer<typeof MobilePermissionInput>;

export const MobileNotificationInput = MobileDeviceIdInput.extend({
  appId: DeviceAppId,
  title: NotificationTitle,
  body: NotificationBody,
}).refine((input) => input.title !== "" || input.body !== "", {
  message: "Give the notification a title or a body.",
});
export type MobileNotificationInput = z.infer<typeof MobileNotificationInput>;

/** What a change did, in a sentence the panel shows next to the control. */
export const MobileConditionResult = z.object({ message: z.string().max(500) });
export type MobileConditionResult = z.infer<typeof MobileConditionResult>;

/** Places a tester often wants, so a location is one click away. */
export const LOCATION_PRESETS = [
  { id: "san-francisco", label: "San Francisco", latitude: 37.7749, longitude: -122.4194 },
  { id: "new-york", label: "New York", latitude: 40.7128, longitude: -74.006 },
  { id: "london", label: "London", latitude: 51.5074, longitude: -0.1278 },
  { id: "tokyo", label: "Tokyo", latitude: 35.6762, longitude: 139.6503 },
  { id: "sydney", label: "Sydney", latitude: -33.8688, longitude: 151.2093 },
] as const;

export type ConditionSupport = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export type DeviceConditionSupport = {
  readonly appearance: ConditionSupport;
  readonly textSize: ConditionSupport;
  readonly location: ConditionSupport;
  readonly clearLocation: ConditionSupport;
  readonly notification: ConditionSupport;
  readonly permissions: Readonly<Record<DevicePermission, ConditionSupport>>;
};

const OK: ConditionSupport = { ok: true };
const no = (reason: string): ConditionSupport => ({ ok: false, reason });

/**
 * Which conditions ZLI can change on a device, with the reason when it cannot. The panel and the desktop both
 * read this, so a disabled control and a refused call give the same reason.
 */
export function deviceConditionSupport(device: Pick<MobileDevice, "platform" | "kind">): DeviceConditionSupport {
  if (device.platform === "ios") {
    if (device.kind === "physical") {
      const physical = no("ZLI changes these settings only on iOS simulators.");
      return {
        appearance: physical,
        textSize: physical,
        location: physical,
        clearLocation: physical,
        notification: physical,
        permissions: allPermissions(physical),
      };
    }
    return {
      appearance: OK,
      textSize: OK,
      location: OK,
      clearLocation: OK,
      notification: OK,
      permissions: {
        ...allPermissions(OK),
        camera: no("The iOS Simulator has no camera, so simctl has no camera permission to set."),
        notifications: no("simctl cannot set notification permission. The app asks for it when it runs."),
      },
    };
  }
  const emulator = device.kind === "emulator";
  return {
    appearance: OK,
    textSize: OK,
    location: emulator ? OK : no("ZLI can set the location only on an emulator. Change it on the phone instead."),
    clearLocation: no("The Android emulator keeps the last location until you set another one."),
    notification: no(
      "Android has no command that posts a notification as your app. Send one from the app or from your push service.",
    ),
    permissions: allPermissions(OK),
  };
}

function allPermissions(support: ConditionSupport): Record<DevicePermission, ConditionSupport> {
  return Object.fromEntries(DEVICE_PERMISSIONS.map((permission) => [permission, support])) as Record<
    DevicePermission,
    ConditionSupport
  >;
}

/**
 * mobile_device_settings from an agent: any mix of changes, applied in the order of the fields. Permissions and
 * the notification need the app id.
 */
export const MobileControlDeviceSettingsInput = MobileControlDeviceInput.extend({
  appearance: DeviceAppearance.optional(),
  textSize: DeviceTextSize.optional(),
  latitude: Latitude.optional(),
  longitude: Longitude.optional(),
  clearLocation: z.boolean().optional(),
  appId: DeviceAppId.optional(),
  grant: z.array(DevicePermission).max(DEVICE_PERMISSIONS.length).optional(),
  revoke: z.array(DevicePermission).max(DEVICE_PERMISSIONS.length).optional(),
  notificationTitle: NotificationTitle.optional(),
  notificationBody: NotificationBody.optional(),
}).superRefine((input, context) => {
  const issue = (message: string) => context.addIssue({ code: "custom", message });
  if ((input.latitude === undefined) !== (input.longitude === undefined)) issue("Pass both latitude and longitude.");
  if (input.latitude !== undefined && input.clearLocation) issue("Set a location or clear it, not both.");
  const notification = Boolean(input.notificationTitle || input.notificationBody);
  if ((input.grant?.length || input.revoke?.length || notification) && !input.appId)
    issue("Permissions and test notifications need appId, such as com.example.app.");
  const both = (input.grant ?? []).filter((permission) => input.revoke?.includes(permission));
  if (both.length > 0) issue(`Grant or revoke ${both.join(", ")}, not both.`);
  const changes =
    input.appearance !== undefined ||
    input.textSize !== undefined ||
    input.latitude !== undefined ||
    input.clearLocation === true ||
    Boolean(input.grant?.length) ||
    Boolean(input.revoke?.length) ||
    notification;
  if (!changes) issue("Pass at least one setting to change.");
});
export type MobileControlDeviceSettingsInput = z.infer<typeof MobileControlDeviceSettingsInput>;
