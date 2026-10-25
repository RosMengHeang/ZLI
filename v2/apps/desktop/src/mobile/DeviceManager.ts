import type { MobileDevice, MobilePanelInput, MobileStreamInfo } from "@zli-v2/contracts";
import type { AndroidDriver } from "./AndroidDriver.js";
import { ANDROID_KEYCODES } from "./adb.js";
import { DeviceLeases, type LeaseOwner } from "./DeviceLeases.js";
import { type DriverDevice, type MobileDriver, MobileDriverError, type Screenshot } from "./MobileDriver.js";
import {
  encodeInjectKeycode,
  encodeInjectText,
  encodeInjectTouch,
  encodeRotateDevice,
  h264CodecString,
  KeyAction,
  MotionAction,
  POINTER_ID_GENERIC_FINGER,
  type VideoEvent,
} from "./scrcpy/protocol.js";
import { ScrcpySession, type ScrcpySessionOptions } from "./scrcpy/ScrcpySession.js";

/** What the Mobile panel receives for a device it shows. Video frames are Annex B H.264 for WebCodecs. */
export type MobileStreamMessage =
  | { type: "info"; info: MobileStreamInfo }
  | { type: "config"; deviceId: string; codec: string; width: number; height: number }
  | { type: "frame"; deviceId: string; key: boolean; timestamp: number; data: Uint8Array }
  | { type: "still"; deviceId: string; data: string; width: number; height: number }
  | { type: "ended"; deviceId: string; reason: string };

export type DeviceManagerEvents = {
  readonly devices?: (devices: MobileDevice[]) => void;
  readonly stream?: (message: MobileStreamMessage) => void;
};

export type DeviceManagerDeps = {
  readonly android: AndroidDriver;
  readonly ios: MobileDriver;
  /** Resolves the verified scrcpy server file, downloading it the first time. */
  readonly scrcpyServer: () => Promise<string>;
  readonly events?: DeviceManagerEvents;
  readonly leases?: DeviceLeases;
  readonly startScrcpy?: (options: ScrcpySessionOptions) => Promise<Pick<ScrcpySession, "send" | "close" | "closed">>;
  readonly stillIntervalMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
};

type Stream = {
  readonly deviceId: string;
  mode: "video" | "stills";
  width: number;
  height: number;
  session?: Pick<ScrcpySession, "send" | "close" | "closed">;
  stopped: boolean;
  /** Where a stills-mode touch started, to tell a tap from a swipe on release. */
  touchStart?: { x: number; y: number; at: number } | undefined;
};

const TAP_SLOP_PX = 12;

/** Every device ZLI can see, who holds each one, and the live view the Mobile panel shows. */
export class DeviceManager {
  readonly #deps: DeviceManagerDeps;
  readonly leases: DeviceLeases;
  readonly #streams = new Map<string, Stream>();
  #devices: MobileDevice[] = [];
  #listing: Promise<MobileDevice[]> | undefined;

  constructor(deps: DeviceManagerDeps) {
    this.#deps = deps;
    this.leases = deps.leases ?? new DeviceLeases({ onChange: () => this.#publish() });
  }

  get drivers(): readonly MobileDriver[] {
    return [this.#deps.android, this.#deps.ios];
  }

  /** The devices from the last list, with current leases. */
  cached(): MobileDevice[] {
    return this.#devices.map((device) => ({ ...device, lease: this.leases.get(device.deviceId) }));
  }

  /** Concurrent callers share one listing, since each one runs adb and simctl. */
  list(): Promise<MobileDevice[]> {
    this.#listing ??= (async () => {
      try {
        const lists = await Promise.all(this.drivers.map((driver) => driver.list().catch((): DriverDevice[] => [])));
        this.#devices = lists.flat().map((device) => ({ ...device, lease: this.leases.get(device.deviceId) }));
        this.#publish();
        return this.cached();
      } finally {
        this.#listing = undefined;
      }
    })();
    return this.#listing;
  }

  async find(deviceId: string): Promise<MobileDevice> {
    const device = (await this.list()).find((candidate) => candidate.deviceId === deviceId);
    if (!device) throw new MobileDriverError(`No device ${deviceId}. List devices with mobile_devices.`, 404);
    return device;
  }

  driverFor(device: Pick<MobileDevice, "platform">): MobileDriver {
    return device.platform === "android" ? this.#deps.android : this.#deps.ios;
  }

  async boot(deviceId: string, options: { window?: boolean; wipeData?: boolean } = {}): Promise<MobileDevice> {
    const device = await this.find(deviceId);
    this.#devices = this.#devices.map((entry) =>
      entry.deviceId === deviceId ? { ...entry, state: "booting" } : entry,
    );
    this.#publish();
    try {
      await this.driverFor(device).boot(device, options);
    } finally {
      await this.list();
    }
    return this.find(deviceId);
  }

  async shutdown(deviceId: string): Promise<void> {
    const device = await this.find(deviceId);
    await this.stopStream(deviceId);
    await this.driverFor(device).shutdown(device);
    this.leases.release(deviceId);
    await this.list();
  }

  /** Person-side lease: taking over replaces any agent's lease until the person hands the device back. */
  takeOver(deviceId: string): void {
    this.leases.acquire(deviceId, PERSON);
  }

  release(deviceId: string): void {
    this.leases.release(deviceId);
  }

  acquireForAgent(deviceId: string, owner: LeaseOwner): void {
    this.leases.acquire(deviceId, owner);
  }

  async screenshot(deviceId: string): Promise<Screenshot> {
    const device = await this.find(deviceId);
    return this.driverFor(device).screenshot(device);
  }

  /**
   * Starts the panel's live view. Android uses scrcpy's H.264 stream; when scrcpy cannot start, and always
   * on iOS, the panel gets screenshots instead, about once a second.
   */
  async startStream(deviceId: string): Promise<MobileStreamInfo> {
    const existing = this.#streams.get(deviceId);
    if (existing && !existing.stopped) return this.#info(existing);
    const device = await this.find(deviceId);
    if (device.state !== "online") throw new MobileDriverError(`${device.name} is not running.`, 409);
    const stream: Stream = { deviceId, mode: "stills", width: 0, height: 0, stopped: false };
    this.#streams.set(deviceId, stream);
    let fallbackReason: string | undefined;
    if (device.platform === "android") {
      try {
        await this.#startVideo(device, stream);
      } catch (cause) {
        fallbackReason = `Live video is unavailable, so the panel shows screenshots: ${cause instanceof Error ? cause.message : String(cause)}`;
      }
    } else {
      fallbackReason = "iOS simulators are shown as screenshots about once a second.";
    }
    if (stream.mode === "stills") void this.#pollStills(device, stream);
    const info = { ...this.#info(stream), ...(fallbackReason ? { fallbackReason: fallbackReason.slice(0, 500) } : {}) };
    this.#deps.events?.stream?.({ type: "info", info });
    return info;
  }

  async stopStream(deviceId: string): Promise<void> {
    const stream = this.#streams.get(deviceId);
    if (!stream) return;
    stream.stopped = true;
    this.#streams.delete(deviceId);
    await stream.session?.close("The panel stopped showing this device.");
  }

  /** Input from the person in the Mobile panel. An agent's lease blocks it until the person takes over. */
  async panelInput(input: MobilePanelInput): Promise<void> {
    const lease = this.leases.get(input.deviceId);
    if (lease?.kind === "agent")
      throw new MobileDriverError(
        `${lease.ownerLabel || "An agent"} is driving this device. Take over to use it.`,
        409,
      );
    const stream = this.#streams.get(input.deviceId);
    const session = stream?.session && !stream.session.closed ? stream.session : undefined;
    if (stream && session) {
      for (const message of scrcpyMessagesFor(input, stream)) session.send(message);
      return;
    }
    const device = await this.find(input.deviceId);
    const driver = this.driverFor(device);
    switch (input.type) {
      case "touch":
        await this.#stillsTouch(device, driver, stream, input);
        return;
      case "text":
        await driver.type(device, input.text);
        return;
      case "button":
        await driver.press(device, input.button);
        return;
      case "rotate":
        await driver.rotate(device, undefined);
        return;
    }
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.#streams.keys()].map((deviceId) => this.stopStream(deviceId)));
    await Promise.all(this.drivers.map((driver) => driver.dispose().catch(() => undefined)));
  }

  async #startVideo(device: MobileDevice, stream: Stream): Promise<void> {
    const connection = await this.#deps.android.connection(device);
    const serverPath = await this.#deps.scrcpyServer();
    let codec: string | undefined;
    const onVideo = (event: VideoEvent) => {
      if (stream.stopped) return;
      if (event.type === "session") {
        stream.width = event.width;
        stream.height = event.height;
        if (codec)
          this.#deps.events?.stream?.({
            type: "config",
            deviceId: device.deviceId,
            codec,
            width: event.width,
            height: event.height,
          });
        return;
      }
      if (event.type !== "frame") return;
      if (event.config) {
        const next = h264CodecString(event.config);
        if (next) {
          codec = next;
          this.#deps.events?.stream?.({
            type: "config",
            deviceId: device.deviceId,
            codec,
            width: stream.width,
            height: stream.height,
          });
        }
      }
      this.#deps.events?.stream?.({
        type: "frame",
        deviceId: device.deviceId,
        key: event.key,
        timestamp: Number(event.pts),
        data: new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength),
      });
    };
    const start = this.#deps.startScrcpy ?? ScrcpySession.start;
    stream.session = await start({
      ...connection,
      serverPath,
      onVideo,
      onClose: (reason) => {
        if (stream.stopped) return;
        stream.stopped = true;
        this.#streams.delete(device.deviceId);
        this.#deps.events?.stream?.({ type: "ended", deviceId: device.deviceId, reason });
      },
    });
    stream.mode = "video";
  }

  async #pollStills(device: MobileDevice, stream: Stream): Promise<void> {
    const driver = this.driverFor(device);
    const sleep =
      this.#deps.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    let failures = 0;
    while (!stream.stopped) {
      try {
        const shot = await driver.screenshot(device);
        if (stream.stopped) break;
        stream.width = shot.width;
        stream.height = shot.height;
        failures = 0;
        this.#deps.events?.stream?.({
          type: "still",
          deviceId: device.deviceId,
          data: shot.data.toString("base64"),
          width: shot.width,
          height: shot.height,
        });
      } catch (cause) {
        failures += 1;
        if (failures >= 3) {
          stream.stopped = true;
          this.#streams.delete(device.deviceId);
          this.#deps.events?.stream?.({
            type: "ended",
            deviceId: device.deviceId,
            reason: `Screenshots stopped working: ${cause instanceof Error ? cause.message : String(cause)}`,
          });
          break;
        }
      }
      await sleep(this.#deps.stillIntervalMs ?? 1_000);
    }
  }

  async #stillsTouch(
    device: MobileDevice,
    driver: MobileDriver,
    stream: Stream | undefined,
    input: Extract<MobilePanelInput, { type: "touch" }>,
  ): Promise<void> {
    if (!stream) throw new MobileDriverError("Open the device in the Mobile panel first.", 409);
    if (input.action === "down") {
      stream.touchStart = { x: input.x, y: input.y, at: Date.now() };
      return;
    }
    if (input.action !== "up" || !stream.touchStart) return;
    const start = stream.touchStart;
    stream.touchStart = undefined;
    const scale = await this.#stillScale(device, driver, stream);
    const from = { x: start.x * scale.x, y: start.y * scale.y };
    const to = { x: input.x * scale.x, y: input.y * scale.y };
    const moved = Math.hypot(input.x - start.x, input.y - start.y);
    const elapsed = Date.now() - start.at;
    if (moved < TAP_SLOP_PX) await driver.tap(device, from.x, from.y, elapsed > 600);
    else await driver.swipe(device, from, to, Math.min(2_000, Math.max(100, elapsed)));
  }

  /** Screenshots are in pixels; iOS taps are in points, so stills coordinates are scaled to the driver's unit. */
  async #stillScale(device: MobileDevice, driver: MobileDriver, stream: Stream): Promise<{ x: number; y: number }> {
    if (device.platform === "android" || stream.width === 0) return { x: 1, y: 1 };
    const size = await driver.screenSize(device);
    return { x: size.width / stream.width, y: size.height / stream.height };
  }

  #info(stream: Stream): MobileStreamInfo {
    return { deviceId: stream.deviceId, mode: stream.mode, width: stream.width, height: stream.height };
  }

  #publish(): void {
    this.#deps.events?.devices?.(this.cached());
  }
}

export const PERSON: LeaseOwner = { ownerId: "person", ownerLabel: "You", kind: "person" };

/** The scrcpy control messages for one panel input, in the stream's frame coordinates. */
export function scrcpyMessagesFor(input: MobilePanelInput, frame: { width: number; height: number }): Buffer[] {
  switch (input.type) {
    case "touch": {
      const action = MotionAction[input.action];
      return [
        encodeInjectTouch({
          action,
          pointerId: POINTER_ID_GENERIC_FINGER,
          position: { x: input.x, y: input.y, width: frame.width, height: frame.height },
          pressure: input.action === "up" ? 0 : 1,
          // Buttons describe mouse input; a finger on a touchscreen carries none.
          actionButton: 0,
          buttons: 0,
        }),
      ];
    }
    case "text":
      return [encodeInjectText(input.text)];
    case "button": {
      const keycode = ANDROID_KEYCODES[input.button];
      return [encodeInjectKeycode(KeyAction.down, keycode), encodeInjectKeycode(KeyAction.up, keycode)];
    }
    case "rotate":
      return [encodeRotateDevice()];
  }
}
