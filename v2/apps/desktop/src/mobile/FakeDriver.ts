import type {
  DeviceAppearance,
  DeviceConditions,
  DeviceLocation,
  DeviceNotification,
  DevicePermission,
  DeviceTextSize,
  MobileButton,
  MobilePlatform,
} from "@zli-v2/contracts";

import type { DriverDevice, LogQuery, LogStream, MobileDriver, Orientation, Screenshot } from "./MobileDriver.js";
import type { UiTree } from "./uiTree.js";

/** A driver that keeps devices in memory and records each action as a readable line. */
export class FakeDriver implements MobileDriver {
  readonly actions: string[] = [];
  tree: UiTree = { nodes: [], depths: [] };
  size = { width: 1080, height: 2400 };
  /** The size taps are measured in, when it differs from the screenshot's pixels, as iOS points do. */
  points: { width: number; height: number } | undefined;
  screenshotError: Error | undefined;
  /** While true, boot leaves the device booting until shutdown stops it, as a slow emulator would. */
  holdBoot = false;
  readonly #heldBoots = new Map<string, () => void>();

  constructor(
    readonly platform: MobilePlatform,
    public devices: DriverDevice[],
  ) {}

  async list(): Promise<DriverDevice[]> {
    return this.devices.map((device) => ({ ...device }));
  }

  async boot(device: DriverDevice): Promise<DriverDevice> {
    this.actions.push(`boot ${device.deviceId}`);
    if (this.holdBoot) {
      this.#setState(device.deviceId, "booting");
      await new Promise<void>((_resolve, reject) => {
        this.#heldBoots.set(device.deviceId, () => reject(new Error("The emulator stopped while booting.")));
      });
    }
    this.#setState(device.deviceId, "online");
    return { ...device, state: "online" };
  }

  async shutdown(device: DriverDevice): Promise<void> {
    this.actions.push(`shutdown ${device.deviceId}`);
    this.#setState(device.deviceId, "shutdown");
    this.#heldBoots.get(device.deviceId)?.();
    this.#heldBoots.delete(device.deviceId);
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
    return this.points ?? this.size;
  }

  async dispose(): Promise<void> {
    this.actions.push("dispose");
  }

  /** Log streams that are running, by device. */
  readonly logStreams = new Map<string, Set<{ emit(line: string): void; stop(): void }>>();
  /** When set, streamLogs rejects with it, as a missing adb would. */
  streamError: Error | undefined;

  async streamLogs(device: DriverDevice): Promise<LogStream> {
    if (this.streamError) throw this.streamError;
    this.actions.push(`stream-logs ${device.deviceId}`);
    const listeners: ((line: string) => void)[] = [];
    let stop: () => void = () => undefined;
    const exited = new Promise<void>((resolve) => {
      stop = resolve;
    });
    const streams = this.logStreams.get(device.deviceId) ?? new Set();
    this.logStreams.set(device.deviceId, streams);
    const entry = {
      emit: (line: string) => {
        for (const listener of listeners) listener(line);
      },
      stop: () => {
        streams.delete(entry);
        stop();
      },
    };
    streams.add(entry);
    return { onLine: (listener) => void listeners.push(listener), stop: entry.stop, exited };
  }

  /** What readConditions answers; the setters below change it. */
  conditions: DeviceConditions = {};

  async readConditions(): Promise<DeviceConditions> {
    return { ...this.conditions };
  }

  async setAppearance(device: DriverDevice, appearance: DeviceAppearance): Promise<void> {
    this.actions.push(`appearance ${device.deviceId} ${appearance}`);
    this.conditions = { ...this.conditions, appearance };
  }

  async setTextSize(device: DriverDevice, textSize: DeviceTextSize): Promise<void> {
    this.actions.push(`text-size ${device.deviceId} ${textSize}`);
    this.conditions = { ...this.conditions, textSize };
  }

  async setLocation(device: DriverDevice, location: DeviceLocation): Promise<void> {
    this.actions.push(`location ${device.deviceId} ${location.latitude},${location.longitude}`);
  }

  async clearLocation(device: DriverDevice): Promise<void> {
    this.actions.push(`clear-location ${device.deviceId}`);
  }

  async setPermission(device: DriverDevice, appId: string, permission: DevicePermission, grant: boolean) {
    this.actions.push(`${grant ? "grant" : "revoke"} ${device.deviceId} ${appId} ${permission}`);
  }

  async sendNotification(device: DriverDevice, appId: string, notification: DeviceNotification): Promise<void> {
    this.actions.push(`notify ${device.deviceId} ${appId} ${notification.title}|${notification.body}`);
  }

  /** Prints lines to every running log stream of the device. Returns how many streams got them. */
  emitLog(deviceId: string, lines: readonly string[]): number {
    const streams = [...(this.logStreams.get(deviceId) ?? [])];
    for (const stream of streams) for (const line of lines) stream.emit(line);
    return streams.length;
  }

  #setState(deviceId: string, state: DriverDevice["state"]): void {
    this.devices = this.devices.map((device) => (device.deviceId === deviceId ? { ...device, state } : device));
  }
}
