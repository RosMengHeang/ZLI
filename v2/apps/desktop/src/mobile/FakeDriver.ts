import type { MobileButton, MobilePlatform } from "@zli-v2/contracts";

import type { DriverDevice, LogQuery, MobileDriver, Orientation, Screenshot } from "./MobileDriver.js";
import type { UiTree } from "./uiTree.js";

/** A driver that keeps devices in memory and records each action as a readable line. */
export class FakeDriver implements MobileDriver {
  readonly actions: string[] = [];
  tree: UiTree = { nodes: [], depths: [] };
  size = { width: 1080, height: 2400 };
  screenshotError: Error | undefined;

  constructor(
    readonly platform: MobilePlatform,
    public devices: DriverDevice[],
  ) {}

  async list(): Promise<DriverDevice[]> {
    return this.devices.map((device) => ({ ...device }));
  }

  async boot(device: DriverDevice): Promise<DriverDevice> {
    this.actions.push(`boot ${device.deviceId}`);
    this.#setState(device.deviceId, "online");
    return { ...device, state: "online" };
  }

  async shutdown(device: DriverDevice): Promise<void> {
    this.actions.push(`shutdown ${device.deviceId}`);
    this.#setState(device.deviceId, "shutdown");
  }

  async install(device: DriverDevice, path: string): Promise<string> {
    this.actions.push(`install ${device.deviceId} ${path}`);
    return "Success";
  }

  async launch(device: DriverDevice, appId: string): Promise<void> {
    this.actions.push(`launch ${device.deviceId} ${appId}`);
  }

  async openUrl(device: DriverDevice, url: string): Promise<{ reversedPort?: number }> {
    this.actions.push(`open ${device.deviceId} ${url}`);
    return {};
  }

  async snapshot(): Promise<UiTree> {
    return this.tree;
  }

  async tap(device: DriverDevice, x: number, y: number, longPress: boolean): Promise<void> {
    this.actions.push(`tap ${device.deviceId} ${x},${y}${longPress ? " long" : ""}`);
  }

  async swipe(
    device: DriverDevice,
    from: { x: number; y: number },
    to: { x: number; y: number },
    durationMs: number,
  ): Promise<void> {
    this.actions.push(`swipe ${device.deviceId} ${from.x},${from.y} ${to.x},${to.y} ${durationMs}`);
  }

  async type(device: DriverDevice, text: string): Promise<void> {
    this.actions.push(`type ${device.deviceId} ${text}`);
  }

  async press(device: DriverDevice, button: MobileButton): Promise<void> {
    this.actions.push(`press ${device.deviceId} ${button}`);
  }

  async rotate(device: DriverDevice, orientation: Orientation | undefined): Promise<Orientation> {
    this.actions.push(`rotate ${device.deviceId}`);
    return orientation ?? "landscape";
  }

  async screenshot(): Promise<Screenshot> {
    if (this.screenshotError) throw this.screenshotError;
    return { data: Buffer.from("png"), width: this.size.width, height: this.size.height };
  }

  async logs(_device: DriverDevice, query: LogQuery): Promise<string[]> {
    return [`${query.lines} lines`];
  }

  async screenSize(): Promise<{ width: number; height: number }> {
    return this.size;
  }

  async dispose(): Promise<void> {
    this.actions.push("dispose");
  }

  #setState(deviceId: string, state: DriverDevice["state"]): void {
    this.devices = this.devices.map((device) => (device.deviceId === deviceId ? { ...device, state } : device));
  }
}
