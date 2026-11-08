import {
  type ConditionSupport,
  DEVICE_PERMISSION_LABELS,
  DEVICE_TEXT_SIZE_LABELS,
  type DeviceAppearance,
  DeviceConditions,
  type DevicePermission,
  type DeviceTextSize,
  deviceConditionSupport,
  MobileAppearanceInput,
  MobileControlDeviceSettingsInput,
  type MobileDevice,
  MobileDeviceIdInput,
  MobileLocationInput,
  MobileNotificationInput,
  MobilePermissionInput,
  MobileTextSizeInput,
} from "@zli-v2/contracts";

import { BrowserControlError } from "../../../browser/BrowserControlActions.js";
import { coordinate } from "../../deviceConditions.js";
import { type MobileDriver, MobileDriverError } from "../../MobileDriver.js";
import type { MobileDevFeature, MobileDevHost } from "../host.js";

export type ConditionChange =
  | { readonly kind: "appearance"; readonly appearance: DeviceAppearance }
  | { readonly kind: "textSize"; readonly textSize: DeviceTextSize }
  | { readonly kind: "location"; readonly latitude: number; readonly longitude: number }
  | { readonly kind: "clearLocation" }
  | {
      readonly kind: "permission";
      readonly appId: string;
      readonly permission: DevicePermission;
      readonly grant: boolean;
    }
  | { readonly kind: "notification"; readonly appId: string; readonly title: string; readonly body: string };

/**
 * Makes one change and says what it did. A change the device cannot take is refused with the reason the panel
 * shows beside the disabled control, before any command runs.
 */
export async function applyCondition(
  device: MobileDevice,
  driver: MobileDriver,
  change: ConditionChange,
): Promise<string> {
  const support = deviceConditionSupport(device);
  const allowed = (entry: ConditionSupport) => {
    if (!entry.ok) throw new MobileDriverError(entry.reason, 409);
  };
  const missing = () => new MobileDriverError(`ZLI cannot change that on ${device.name}.`, 501);
  switch (change.kind) {
    case "appearance":
      allowed(support.appearance);
      if (!driver.setAppearance) throw missing();
      await driver.setAppearance(device, change.appearance);
      return `Switched ${device.name} to ${change.appearance} appearance.`;
    case "textSize":
      allowed(support.textSize);
      if (!driver.setTextSize) throw missing();
      await driver.setTextSize(device, change.textSize);
      return `Set the text size on ${device.name} to ${DEVICE_TEXT_SIZE_LABELS[change.textSize]}.`;
    case "location":
      allowed(support.location);
      if (!driver.setLocation) throw missing();
      await driver.setLocation(device, { latitude: change.latitude, longitude: change.longitude });
      return `Set the location on ${device.name} to ${coordinate(change.latitude)}, ${coordinate(change.longitude)}.`;
    case "clearLocation":
      allowed(support.clearLocation);
      if (!driver.clearLocation) throw missing();
      await driver.clearLocation(device);
      return `Cleared the location set on ${device.name}.`;
    case "permission": {
      allowed(support.permissions[change.permission]);
      if (!driver.setPermission) throw missing();
      await driver.setPermission(device, change.appId, change.permission, change.grant);
      const label = DEVICE_PERMISSION_LABELS[change.permission].toLowerCase();
      return change.grant ? `Granted ${label} to ${change.appId}.` : `Revoked ${label} from ${change.appId}.`;
    }
    case "notification":
      allowed(support.notification);
      if (!driver.sendNotification) throw missing();
      await driver.sendNotification(device, change.appId, { title: change.title, body: change.body });
      return `Sent a test notification to ${change.appId}.`;
  }
}

/** The agent's changes in a fixed order: the device first, then the app's permissions, then the notification. */
export function agentChanges(input: MobileControlDeviceSettingsInput): ConditionChange[] {
  const changes: ConditionChange[] = [];
  if (input.appearance) changes.push({ kind: "appearance", appearance: input.appearance });
  if (input.textSize) changes.push({ kind: "textSize", textSize: input.textSize });
  if (input.latitude !== undefined && input.longitude !== undefined)
    changes.push({ kind: "location", latitude: input.latitude, longitude: input.longitude });
  if (input.clearLocation) changes.push({ kind: "clearLocation" });
  const appId = input.appId;
  if (appId) {
    for (const permission of input.grant ?? []) changes.push({ kind: "permission", appId, permission, grant: true });
    for (const permission of input.revoke ?? []) changes.push({ kind: "permission", appId, permission, grant: false });
    const title = input.notificationTitle ?? "";
    const body = input.notificationBody ?? "";
    if (title || body) changes.push({ kind: "notification", appId, title, body });
  }
  return changes;
}

/**
 * Device settings for testing an app: appearance, text size, location, app permissions, and a test notification.
 * The panel's channels refuse while an agent holds the device, like every other panel action.
 */
export function createConditions(host: MobileDevHost): MobileDevFeature {
  const panel = async (deviceId: string) => {
    const manager = host.manager();
    if (!manager) throw new BrowserControlError("ZLI's mobile service is still starting. Try again in a moment.", 503);
    return manager.panelDevice(deviceId);
  };
  const change = async (deviceId: string, next: ConditionChange) => {
    const { device, driver } = await panel(deviceId);
    return { message: await applyCondition(device, driver, next) };
  };

  return {
    actions: {
      mobiledevicesettings: async (input, context) => {
        const parsed = MobileControlDeviceSettingsInput.parse(input ?? {});
        const { device, driver } = await context.online(parsed);
        const done: string[] = [];
        for (const next of agentChanges(parsed)) {
          try {
            done.push(await applyCondition(device, driver, next));
          } catch (cause) {
            if (done.length === 0) throw cause;
            const reason = cause instanceof Error ? cause.message : String(cause);
            throw new MobileDriverError(
              `${done.join(" ")} Then it stopped: ${reason}`,
              cause instanceof MobileDriverError ? cause.status : 500,
            );
          }
        }
        return { deviceId: device.deviceId, done };
      },
    },
    ipc: {
      "zli:mobile:conditions:get": async (input) => {
        const { device, driver } = await panel(MobileDeviceIdInput.parse(input).deviceId);
        return driver.readConditions ? DeviceConditions.parse(await driver.readConditions(device)) : {};
      },
      "zli:mobile:conditions:appearance": (input) => {
        const parsed = MobileAppearanceInput.parse(input);
        return change(parsed.deviceId, { kind: "appearance", appearance: parsed.appearance });
      },
      "zli:mobile:conditions:text-size": (input) => {
        const parsed = MobileTextSizeInput.parse(input);
        return change(parsed.deviceId, { kind: "textSize", textSize: parsed.textSize });
      },
      "zli:mobile:conditions:location": (input) => {
        const parsed = MobileLocationInput.parse(input);
        return change(parsed.deviceId, { kind: "location", latitude: parsed.latitude, longitude: parsed.longitude });
      },
      "zli:mobile:conditions:clear-location": (input) =>
        change(MobileDeviceIdInput.parse(input).deviceId, { kind: "clearLocation" }),
      "zli:mobile:conditions:permission": (input) => {
        const parsed = MobilePermissionInput.parse(input);
        return change(parsed.deviceId, {
          kind: "permission",
          appId: parsed.appId,
          permission: parsed.permission,
          grant: parsed.grant,
        });
      },
      "zli:mobile:conditions:notify": (input) => {
        const parsed = MobileNotificationInput.parse(input);
        return change(parsed.deviceId, {
          kind: "notification",
          appId: parsed.appId,
          title: parsed.title,
          body: parsed.body,
        });
      },
    },
    decorate: undefined,
    testOps: {},
    dispose() {},
  };
}
