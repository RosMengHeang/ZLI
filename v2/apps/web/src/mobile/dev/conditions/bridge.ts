import type {
  DeviceAppearance,
  DeviceConditions,
  DeviceLocation,
  DevicePermission,
  DeviceTextSize,
  MobileConditionResult,
} from "@zli-v2/contracts";

/** Device settings for testing an app. Each change answers with a sentence saying what it did. */
export type ConditionsApi = {
  /** The appearance and text size the device reports. Fields it did not report are missing. */
  get(deviceId: string): Promise<DeviceConditions>;
  setAppearance(deviceId: string, appearance: DeviceAppearance): Promise<MobileConditionResult>;
  setTextSize(deviceId: string, textSize: DeviceTextSize): Promise<MobileConditionResult>;
  setLocation(deviceId: string, location: DeviceLocation): Promise<MobileConditionResult>;
  clearLocation(deviceId: string): Promise<MobileConditionResult>;
  setPermission(
    deviceId: string,
    request: { appId: string; permission: DevicePermission; grant: boolean },
  ): Promise<MobileConditionResult>;
  sendNotification(
    deviceId: string,
    notification: { appId: string; title: string; body: string },
  ): Promise<MobileConditionResult>;
};

/** window.zli.mobile.dev.conditions. Absent in builds and test bridges without it. */
export type ConditionsBridge = { conditions?: ConditionsApi };
