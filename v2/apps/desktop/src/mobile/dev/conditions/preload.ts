import {
  type DeviceAppearance,
  DeviceConditions,
  type DeviceLocation,
  type DevicePermission,
  type DeviceTextSize,
  MobileAppearanceInput,
  MobileConditionResult,
  MobileDeviceIdInput,
  MobileLocationInput,
  MobileNotificationInput,
  MobilePermissionInput,
  MobileTextSizeInput,
} from "@zli-v2/contracts";

import type { PreloadIpc } from "../preloadIpc.js";

/**
 * window.zli.mobile.dev.conditions: the Device settings drawer. Each call takes fixed choices or checked values,
 * so the renderer never builds a command line.
 */
export function createConditionsApi(ipc: PreloadIpc) {
  const change = async (channel: string, payload: unknown) =>
    MobileConditionResult.parse(await ipc.invoke(channel, payload));
  return {
    conditions: {
      get: async (deviceId: string) =>
        DeviceConditions.parse(await ipc.invoke("zli:mobile:conditions:get", MobileDeviceIdInput.parse({ deviceId }))),
      setAppearance: async (deviceId: string, appearance: DeviceAppearance) =>
        change("zli:mobile:conditions:appearance", MobileAppearanceInput.parse({ deviceId, appearance })),
      setTextSize: async (deviceId: string, textSize: DeviceTextSize) =>
        change("zli:mobile:conditions:text-size", MobileTextSizeInput.parse({ deviceId, textSize })),
      setLocation: async (deviceId: string, location: DeviceLocation) =>
        change("zli:mobile:conditions:location", MobileLocationInput.parse({ deviceId, ...location })),
      clearLocation: async (deviceId: string) =>
        change("zli:mobile:conditions:clear-location", MobileDeviceIdInput.parse({ deviceId })),
      setPermission: async (
        deviceId: string,
        request: { appId: string; permission: DevicePermission; grant: boolean },
      ) => change("zli:mobile:conditions:permission", MobilePermissionInput.parse({ deviceId, ...request })),
      sendNotification: async (deviceId: string, notification: { appId: string; title: string; body: string }) =>
        change("zli:mobile:conditions:notify", MobileNotificationInput.parse({ deviceId, ...notification })),
    },
  };
}
