import type { MobileButton, MobileDevice, MobilePlatform } from "@zli-v2/contracts";

import type { UiTree } from "./uiTree.js";

/** A device as a driver sees it; leases are added by the DeviceManager. */
export type DriverDevice = Omit<MobileDevice, "lease">;

export type Orientation = "portrait" | "landscape" | "portrait-reverse" | "landscape-reverse";

export type Screenshot = { readonly data: Buffer; readonly width: number; readonly height: number };

export type LogQuery = { readonly appId?: string; readonly lines: number; readonly filter?: string };

/** What one platform can do with its devices. Coordinates are in the unit the platform's tree reports. */
export type MobileDriver = {
  readonly platform: MobilePlatform;
  list(): Promise<DriverDevice[]>;
  boot(device: DriverDevice, options: { window?: boolean; wipeData?: boolean }): Promise<DriverDevice>;
  shutdown(device: DriverDevice): Promise<void>;
  install(device: DriverDevice, path: string): Promise<string>;
  launch(device: DriverDevice, appId: string, options: { stop?: boolean }): Promise<void>;
  openUrl(device: DriverDevice, url: string): Promise<{ reversedPort?: number }>;
  snapshot(device: DriverDevice): Promise<UiTree>;
  tap(device: DriverDevice, x: number, y: number, longPress: boolean): Promise<void>;
  swipe(
    device: DriverDevice,
    from: { x: number; y: number },
    to: { x: number; y: number },
    durationMs: number,
  ): Promise<void>;
  type(device: DriverDevice, text: string): Promise<void>;
  press(device: DriverDevice, button: MobileButton): Promise<void>;
  rotate(device: DriverDevice, orientation: Orientation | undefined): Promise<Orientation>;
  screenshot(device: DriverDevice): Promise<Screenshot>;
  logs(device: DriverDevice, query: LogQuery): Promise<string[]>;
  /** The size tap and swipe coordinates are measured in. */
  screenSize(device: DriverDevice): Promise<{ width: number; height: number }>;
  /** Stops processes this driver started, such as emulators, when ZLI quits. */
  dispose(): Promise<void>;
};

export class MobileDriverError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "MobileDriverError";
  }
}
