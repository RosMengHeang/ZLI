import type {
  MobileAndroidStatus,
  MobileButton,
  MobileDevice,
  MobileDeviceState,
  MobilePanelInput,
  MobileSetupPlan,
  MobileSetupProgress,
} from "@zli-v2/contracts";

import type { MobileBridge } from "../runtime/bridge.js";
import type { BadgeTone } from "../ui/Badge.js";

/** Electron prefixes errors from the main process with the channel name; the person only needs the reason. */
export function errorText(cause: unknown, fallback: string): string {
  const raw = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  const message = raw.replace(/^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/u, "").trim();
  return message || fallback;
}

export function stateLabel(state: MobileDeviceState): string {
  switch (state) {
    case "online":
      return "Running";
    case "booting":
      return "Booting";
    case "shutdown":
      return "Off";
    case "offline":
      return "Offline";
    case "unauthorized":
      return "Waiting for approval";
  }
}

export function deviceKindLabel(device: Pick<MobileDevice, "platform" | "kind">): string {
  if (device.kind === "physical") return device.platform === "ios" ? "iPhone" : "Android phone";
  return device.platform === "ios" ? "iOS Simulator" : "Android Emulator";
}

export type DeviceGroup = "Emulators" | "Phones" | "Simulators";

const DEVICE_GROUPS: readonly DeviceGroup[] = ["Emulators", "Phones", "Simulators"];

export function deviceGroup(device: Pick<MobileDevice, "kind">): DeviceGroup {
  if (device.kind === "physical") return "Phones";
  return device.kind === "simulator" ? "Simulators" : "Emulators";
}

/** The devices in picker order: emulators, then phones, then simulators, each kept in list order. */
export function devicesInGroups(devices: readonly MobileDevice[]): MobileDevice[] {
  return DEVICE_GROUPS.flatMap((group) => devices.filter((device) => deviceGroup(device) === group));
}

/** The platform, version, and state under a device's name in the picker, for example "Android 15, running". */
export function deviceSummary(device: Pick<MobileDevice, "platform" | "osVersion" | "state">): string {
  const platform = device.platform === "ios" ? "iOS" : "Android";
  return `${platform}${device.osVersion ? ` ${device.osVersion}` : ""}, ${stateLabel(device.state).toLowerCase()}`;
}
/** Under this much time left, the agent banner counts down instead of naming the time. */
const LEASE_COUNTDOWN_MS = 2 * 60_000;

/**
 * What the panel says about who holds a device, or nothing when it is free. An agent's lease names when it
 * ends in the local time zone, and counts down in its last two minutes.
 */
export function leaseNotice(
  device: Pick<MobileDevice, "lease">,
  clock: { now?: number; locale?: string; timeZone?: string } = {},
): { kind: "agent" | "person"; text: string } | undefined {
  const lease = device.lease;
  if (!lease) return undefined;
  if (lease.kind === "person")
    return { kind: "person", text: "You have control. Agents cannot use this device until you hand it back." };
  const owner = lease.ownerLabel || "An agent";
  const ends = lease.expiresAt === undefined ? Number.NaN : Date.parse(lease.expiresAt);
  if (Number.isNaN(ends))
    return { kind: "agent", text: `${owner} is using this device. Take over to use it yourself.` };
  const left = ends - (clock.now ?? Date.now());
  let until: string;
  if (left >= LEASE_COUNTDOWN_MS) {
    const time = new Intl.DateTimeFormat(clock.locale, {
      hour: "numeric",
      minute: "2-digit",
      ...(clock.timeZone ? { timeZone: clock.timeZone } : {}),
    }).format(ends);
    until = `until ${time}`;
  } else if (left >= 60_000) {
    const minutes = Math.round(left / 60_000);
    until = `for about ${minutes} more ${minutes === 1 ? "minute" : "minutes"}`;
  } else until = "for less than a minute more";
  return { kind: "agent", text: `${owner} is using this device ${until}. Take over to use it yourself.` };
}

/**
 * Maps a pointer position on the shown screen to the frame's own pixels. The screen element keeps the
 * frame's aspect ratio, so the mapping is a plain scale; points outside it return undefined.
 */
export function framePoint(
  client: { x: number; y: number },
  rect: { left: number; top: number; width: number; height: number },
  frame: { width: number; height: number },
): { x: number; y: number } | undefined {
  if (rect.width <= 0 || rect.height <= 0 || frame.width <= 0 || frame.height <= 0) return undefined;
  const relativeX = (client.x - rect.left) / rect.width;
  const relativeY = (client.y - rect.top) / rect.height;
  if (relativeX < 0 || relativeX > 1 || relativeY < 0 || relativeY > 1) return undefined;
  return {
    x: Math.min(frame.width - 1, Math.round(relativeX * frame.width)),
    y: Math.min(frame.height - 1, Math.round(relativeY * frame.height)),
  };
}

export type TouchStep = { action: "down" | "move" | "up"; x: number; y: number };

/** The longest wheel swipe, as a share of the frame, so one burst of scrolling never flings a whole page. */
const WHEEL_MAX_SHARE = 0.4;

/**
 * The touch path that scrolls a device like one burst of mouse wheel. Wheel down scrolls content up, as on a
 * desktop page, so the finger moves up. delta and point are in frame pixels. The path starts at the pointer,
 * shifted only when needed to keep the whole swipe on the screen. Returns no steps when the burst is too
 * small to move anything.
 */
export function wheelSwipe(
  delta: { x: number; y: number },
  point: { x: number; y: number },
  frame: { width: number; height: number },
  moves = 4,
): TouchStep[] {
  const axis = (value: number, size: number) => {
    const limit = size * WHEEL_MAX_SHARE;
    return -Math.round(Math.max(-limit, Math.min(limit, value)));
  };
  const dx = axis(delta.x, frame.width);
  const dy = axis(delta.y, frame.height);
  if (dx === 0 && dy === 0) return [];
  const start = (value: number, size: number, distance: number) =>
    Math.round(Math.max(Math.max(0, -distance), Math.min(size - 1 - Math.max(0, distance), value)));
  const from = { x: start(point.x, frame.width, dx), y: start(point.y, frame.height, dy) };
  const steps: TouchStep[] = [{ action: "down", ...from }];
  for (let index = 1; index <= moves; index += 1)
    steps.push({
      action: "move",
      x: Math.round(from.x + (dx * index) / moves),
      y: Math.round(from.y + (dy * index) / moves),
    });
  steps.push({ action: "up", x: from.x + dx, y: from.y + dy });
  return steps;
}

/** Wheel deltas in CSS pixels, whatever unit the event used. */
export function wheelPixels(
  event: { deltaX: number; deltaY: number; deltaMode: number },
  page: { width: number; height: number },
): { x: number; y: number } {
  if (event.deltaMode === 1) return { x: event.deltaX * 40, y: event.deltaY * 40 };
  if (event.deltaMode === 2) return { x: event.deltaX * page.width, y: event.deltaY * page.height };
  return { x: event.deltaX, y: event.deltaY };
}

const KEY_BUTTONS: Record<string, MobileButton> = {
  Enter: "enter",
  Backspace: "delete",
  Escape: "back",
  Tab: "tab",
  ArrowUp: "dpad_up",
  ArrowDown: "dpad_down",
  ArrowLeft: "dpad_left",
  ArrowRight: "dpad_right",
};

/**
 * The device input for a key pressed while the screen has focus. Shortcuts with Ctrl, Cmd, or Alt stay with
 * ZLI, and Shift+Tab moves focus out of the screen so the keyboard is never trapped on the device.
 */
export function keyInput(
  deviceId: string,
  event: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey?: boolean },
): MobilePanelInput | undefined {
  if (event.ctrlKey || event.metaKey || event.altKey) return undefined;
  if (event.key === "Tab" && event.shiftKey) return undefined;
  const button = KEY_BUTTONS[event.key];
  if (button) return { deviceId, type: "button", button };
  if ([...event.key].length === 1) return { deviceId, type: "text", text: event.key };
  return undefined;
}

/** The most text one panel input carries; the contract refuses longer strings. */
export const TEXT_INPUT_MAX = 300;

/** Splits text into pieces short enough for one input each, never through the middle of a character. */
export function textChunks(text: string, size = TEXT_INPUT_MAX): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const character of text) {
    if (current.length + character.length > size) {
      chunks.push(current);
      current = "";
    }
    current += character;
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Types text on the device in order, one input per chunk. */
export async function sendTextInput(
  mobile: Pick<MobileBridge, "input">,
  deviceId: string,
  text: string,
): Promise<void> {
  for (const chunk of textChunks(text)) await mobile.input({ deviceId, type: "text", text: chunk });
}

export function isPasteShortcut(event: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "v";
}

/** A running time as m:ss, for example 0:42 or 12:05. */
export function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** After this long a boot is slow enough to suggest something may be wrong. */
export const SLOW_BOOT_MS = 3 * 60_000;

export function slowBootNote(device: Pick<MobileDevice, "platform">): string {
  return device.platform === "android"
    ? "This is taking longer than usual. Open Setup to check that the emulator can use hardware acceleration."
    : "This is taking longer than usual. Check the Simulator app for a prompt or an error.";
}

/** How the screen is arriving: live video, or screenshots and the reason video is not available. */
export type ScreenMode = { live: boolean; reason: string | undefined };

export function screenModeChip(mode: ScreenMode): { label: string; tone: BadgeTone; title: string | undefined } {
  if (mode.live) return { label: "Live", tone: "success", title: undefined };
  return { label: "Screenshots, about 1 per second", tone: "quiet", title: mode.reason };
}

/** Schemes that carry no //, such as mailto:, which a typed URL keeps as is. */
const OPAQUE_SCHEMES = /^(?:mailto|tel|sms|geo|intent|market):/iu;

/** The URL to open for what was typed. Without a scheme, as in localhost:3000, it opens as http. */
export function urlToOpen(typed: string): string | undefined {
  const url = typed.trim();
  if (!url) return undefined;
  return /^[a-z][a-z\d+.-]*:\/\//iu.test(url) || OPAQUE_SCHEMES.test(url) ? url : `http://${url}`;
}

export function openedNotice(url: string, result: { reversedPort?: number | undefined }): string {
  return result.reversedPort === undefined
    ? `Opened ${url}.`
    : `Opened ${url}. Forwarded localhost:${result.reversedPort} to the device.`;
}

/** A dev server the panel can offer to open on a device: its port, address, and the terminal it runs in. */
export type DevServerHint = { port: number; url: string; name?: string | undefined };

/** Metro's port, then the ports older Expo releases used for Metro and for the web build. */
const EXPO_PORTS = [8081, 19000, 19006] as const;

/**
 * The Expo or Metro server among a worktree's dev servers, newest first, or undefined. A server counts when
 * it is on an Expo port or its terminal's name says expo or metro. The web-only port 19006 is a last resort.
 */
export function expoServer(servers: readonly DevServerHint[]): DevServerHint | undefined {
  const named = (server: DevServerHint) => /expo|metro/iu.test(server.name ?? "");
  return (
    servers.find((server) => named(server) || server.port === EXPO_PORTS[0] || server.port === EXPO_PORTS[1]) ??
    servers.find((server) => server.port === EXPO_PORTS[2])
  );
}

export function expoUrl(server: Pick<DevServerHint, "port">): string {
  return `exp://localhost:${server.port}`;
}

const IMAGE_TAGS: Record<string, string> = {
  default: "AOSP",
  google_apis: "Google APIs",
  google_apis_playstore: "Google Play",
  google_atd: "Google ATD",
  aosp_atd: "AOSP ATD",
};

/** system-images;android-35;google_apis;x86_64 reads as "API 35, Google APIs, x86_64". */
export function systemImageLabel(image: string): string {
  const [, api = "", tag = "", abi = ""] = image.split(";");
  const level = /^android-(\d+)$/u.exec(api)?.[1];
  return [level ? `API ${level}` : api.replace(/^android-/u, ""), IMAGE_TAGS[tag] ?? tag.replaceAll("_", " "), abi]
    .filter(Boolean)
    .join(", ");
}

/** A free name such as Pixel_7_API_35 for a new virtual device, numbered when the name is taken. */
export function suggestAvdName(profileName: string, image: string | undefined, taken: readonly string[]): string {
  const level = image ? /;android-([A-Za-z0-9]+);/u.exec(image)?.[1] : undefined;
  const base =
    `${profileName}${level ? ` API ${level}` : ""}`
      .replace(/[^A-Za-z0-9_.-]+/gu, "_")
      .replace(/^[^A-Za-z0-9]+|_+$/gu, "")
      .slice(0, 50) || "Device";
  const used = new Set(taken.map((name) => name.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let index = 2; ; index += 1) if (!used.has(`${base}_${index}`.toLowerCase())) return `${base}_${index}`;
}

/** The line count the Logs drawer asks for, from what was typed: 1 to 2,000, or 200 when it is not a number. */
export function logLineCount(typed: string): number {
  const value = Number.parseInt(typed, 10);
  return Number.isFinite(value) ? Math.max(1, Math.min(2_000, value)) : 200;
}

/** A screenshot from the bridge as image data the clipboard accepts. */
export function screenshotBlob(shot: { data: string; mimeType: string }): Blob {
  const bytes = Uint8Array.from(atob(shot.data), (character) => character.charCodeAt(0));
  return new Blob([bytes], { type: shot.mimeType });
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** The device to show: the remembered one if it still exists, else a running one, else the first. */
export function pickDevice(devices: readonly MobileDevice[], preferred: string | undefined): MobileDevice | undefined {
  return (
    devices.find((device) => device.deviceId === preferred) ??
    devices.find((device) => device.state === "online") ??
    devices[0]
  );
}

/**
 * How far Android is from booting an emulator: install means adb or the emulator is missing, create means
 * the SDK is there but has no virtual device, and ready means at least one virtual device exists.
 */
export type AndroidSituation = "install" | "create" | "ready";

export function androidSituation(android: MobileAndroidStatus): AndroidSituation {
  if (!android.adb.found || !android.emulator.found) return "install";
  return android.avds.length === 0 ? "create" : "ready";
}

export function androidNeedsInstall(android: MobileAndroidStatus): boolean {
  return androidSituation(android) !== "ready";
}

/** Why the emulator would be too slow to use, or undefined when acceleration works or was not checked. */
export function accelerationProblem(android: MobileAndroidStatus): string | undefined {
  const { checked, usable, detail } = android.acceleration;
  if (!checked || usable) return undefined;
  return detail.trim() || "The emulator cannot use hardware acceleration on this computer.";
}

/** How far the current setup step is, from 0 to 100, or undefined when the step does not say. */
export function progressPercent(progress: MobileSetupProgress): number | undefined {
  if (progress.percent !== undefined) return progress.percent;
  if (progress.totalBytes && progress.receivedBytes !== undefined)
    return Math.min(100, (progress.receivedBytes / progress.totalBytes) * 100);
  return undefined;
}

/** The plan's download size, and whether some steps did not report one. */
export function planDownload(plan: Pick<MobileSetupPlan, "steps">): { bytes: number; partial: boolean } {
  let bytes = 0;
  let partial = false;
  for (const step of plan.steps) {
    if (step.bytes === undefined) partial = true;
    else bytes += step.bytes;
  }
  return { bytes, partial };
}
