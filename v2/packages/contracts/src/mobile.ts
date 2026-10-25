import { z } from "zod";

import { BrowserControlTarget } from "./browser.js";

export const MobilePlatform = z.enum(["android", "ios"]);
export type MobilePlatform = z.infer<typeof MobilePlatform>;

/** emulator and simulator are virtual devices ZLI can boot; physical devices are only listed and driven. */
export const MobileDeviceKind = z.enum(["emulator", "simulator", "physical"]);
export type MobileDeviceKind = z.infer<typeof MobileDeviceKind>;

/** shutdown devices can be booted. unauthorized means the phone has not trusted this computer yet. */
export const MobileDeviceState = z.enum(["shutdown", "booting", "online", "offline", "unauthorized"]);
export type MobileDeviceState = z.infer<typeof MobileDeviceState>;

/** Who is driving a device. A person always wins: their lease replaces an agent's and does not expire. */
export const MobileLease = z.object({
  ownerId: z.string().min(1).max(200),
  ownerLabel: z.string().max(200),
  kind: z.enum(["agent", "person"]),
  acquiredAt: z.string(),
  /** Absent for a person's lease, which lasts until they release it. */
  expiresAt: z.string().optional(),
});
export type MobileLease = z.infer<typeof MobileLease>;

export const MobileDevice = z.object({
  /** Stable across boots: android-avd:<name>, android:<serial>, or ios:<udid>. */
  deviceId: z.string().min(1).max(300),
  platform: MobilePlatform,
  kind: MobileDeviceKind,
  name: z.string().max(200),
  state: MobileDeviceState,
  osVersion: z.string().max(100).optional(),
  /** adb serial while an Android device is connected. */
  serial: z.string().max(200).optional(),
  lease: MobileLease.nullable(),
});
export type MobileDevice = z.infer<typeof MobileDevice>;

export const MobileToolProbe = z.object({
  found: z.boolean(),
  path: z.string().optional(),
  version: z.string().optional(),
});
export type MobileToolProbe = z.infer<typeof MobileToolProbe>;

export const MobileHost = z.object({
  os: z.enum(["linux", "macos", "windows"]),
  arch: z.enum(["x64", "arm64"]),
});
export type MobileHost = z.infer<typeof MobileHost>;

export const MobileAndroidStatus = z.object({
  /** Where the SDK lives, and whether it came from ANDROID_HOME, a default install location, or ZLI's own copy. */
  sdkRoot: z.string().optional(),
  sdkSource: z.enum(["env", "default", "zli", "none"]),
  adb: MobileToolProbe,
  emulator: MobileToolProbe,
  sdkmanager: MobileToolProbe,
  avdmanager: MobileToolProbe,
  java: MobileToolProbe,
  systemImages: z.array(z.string()),
  avds: z.array(z.string()),
  /** Hardware acceleration for the emulator. Without it an emulator is too slow to use. */
  acceleration: z.object({ checked: z.boolean(), usable: z.boolean(), detail: z.string().max(2_000) }),
  /** Plain-language names of what is missing before an emulator can boot. */
  missing: z.array(z.string()),
});
export type MobileAndroidStatus = z.infer<typeof MobileAndroidStatus>;

export const MobileIosStatus = z.object({
  /** iOS Simulator runs only on macOS with Xcode. */
  supported: z.boolean(),
  simctl: MobileToolProbe,
  /** idb drives taps, swipes, typing, and the accessibility tree. Without it only boot, install, launch, and screenshots work. */
  idb: MobileToolProbe,
  missing: z.array(z.string()),
});
export type MobileIosStatus = z.infer<typeof MobileIosStatus>;

export const MobileSetupStatus = z.object({
  host: MobileHost,
  android: MobileAndroidStatus,
  ios: MobileIosStatus,
});
export type MobileSetupStatus = z.infer<typeof MobileSetupStatus>;

export const MobileLicense = z.object({
  id: z.string().min(1).max(100),
  title: z.string().max(200),
  text: z.string().max(200_000),
});
export type MobileLicense = z.infer<typeof MobileLicense>;

export const MobileSetupStep = z.object({
  id: z.string().min(1).max(200),
  label: z.string().max(300),
  /** Download size when known. */
  bytes: z.number().int().nonnegative().optional(),
});
export type MobileSetupStep = z.infer<typeof MobileSetupStep>;

/** What Android setup will download and install, and the licenses the person must accept first. */
export const MobileSetupPlan = z.object({
  sdkRoot: z.string(),
  steps: z.array(MobileSetupStep),
  licenses: z.array(MobileLicense),
  systemImage: z.string(),
  avdName: z.string(),
});
export type MobileSetupPlan = z.infer<typeof MobileSetupPlan>;

export const MobileSetupRunInput = z.object({
  /** License ids the person accepted. Setup refuses to start unless this covers every license in the plan. */
  acceptedLicenses: z.array(z.string().min(1).max(100)).max(50),
});
export type MobileSetupRunInput = z.infer<typeof MobileSetupRunInput>;

export const MobileSetupProgress = z.object({
  state: z.enum(["idle", "running", "done", "failed", "cancelled"]),
  stepId: z.string().optional(),
  message: z.string().max(2_000),
  receivedBytes: z.number().int().nonnegative().optional(),
  totalBytes: z.number().int().nonnegative().optional(),
  /** sdkmanager reports percentages rather than byte counts. */
  percent: z.number().min(0).max(100).optional(),
});
export type MobileSetupProgress = z.infer<typeof MobileSetupProgress>;

/** What avdmanager accepts as a virtual device name. It also becomes a file name and an emulator argument. */
export const MobileAvdName = z
  .string()
  .min(1, "Give the virtual device a name.")
  .max(60, "Use at most 60 characters.")
  // A leading dash would read as an option to avdmanager and the emulator.
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u, "Use letters, digits, and _ . - only, starting with a letter or digit.");
export type MobileAvdName = z.infer<typeof MobileAvdName>;

/** An installed system image as an sdkmanager package id, such as system-images;android-35;google_apis;x86_64. */
export const MobileSystemImageId = z
  .string()
  .max(200)
  .regex(/^system-images;[A-Za-z0-9_.-]+;[A-Za-z0-9_.-]+;[A-Za-z0-9_.-]+$/u, "That is not a system image id.");

/** A hardware profile id from avdmanager list device, such as pixel_7. */
export const MobileDeviceProfileId = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9_.-]+$/u, "That is not a device profile id.");

export const MobileAvd = z.object({
  name: z.string().min(1).max(200),
  displayName: z.string().max(200),
  systemImage: z.string().max(200).optional(),
});
export type MobileAvd = z.infer<typeof MobileAvd>;

export const MobileAvdList = z.object({
  /** Without avdmanager, virtual devices can be listed but not created or deleted. */
  avdmanager: z.boolean(),
  avds: z.array(MobileAvd).max(500),
  /** Only images already installed; creating a device never downloads one. */
  systemImages: z.array(z.string().max(200)).max(500),
  /** Hardware profiles to offer, the default first. */
  deviceProfiles: z.array(z.object({ id: MobileDeviceProfileId, name: z.string().min(1).max(200) })).max(50),
  defaultDeviceProfile: MobileDeviceProfileId,
});
export type MobileAvdList = z.infer<typeof MobileAvdList>;

export const MobileAvdCreateInput = z.object({
  name: MobileAvdName,
  systemImage: MobileSystemImageId,
  device: MobileDeviceProfileId.optional(),
});
export type MobileAvdCreateInput = z.infer<typeof MobileAvdCreateInput>;

export const MobileAvdDeleteInput = z.object({ name: MobileAvdName });
export type MobileAvdDeleteInput = z.infer<typeof MobileAvdDeleteInput>;

/** Settings the person controls. agentTools off hides the zli-mobile tools from agents and refuses their calls. */
export const MobileSettings = z.object({ agentTools: z.boolean() });
export type MobileSettings = z.infer<typeof MobileSettings>;
export const DEFAULT_MOBILE_SETTINGS: MobileSettings = { agentTools: true };

export const MobileDeviceIdInput = z.object({ deviceId: z.string().min(1).max(300) });
export type MobileDeviceIdInput = z.infer<typeof MobileDeviceIdInput>;

export const MobileButton = z.enum([
  "back",
  "home",
  "recents",
  "power",
  "volume_up",
  "volume_down",
  "enter",
  "delete",
  "tab",
  "dpad_up",
  "dpad_down",
  "dpad_left",
  "dpad_right",
]);
export type MobileButton = z.infer<typeof MobileButton>;

/** Input from the Mobile panel. Coordinates are device pixels. */
export const MobilePanelInput = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("touch"),
    deviceId: z.string().min(1).max(300),
    action: z.enum(["down", "move", "up"]),
    x: z.number().min(0).max(100_000),
    y: z.number().min(0).max(100_000),
  }),
  z.object({ type: z.literal("text"), deviceId: z.string().min(1).max(300), text: z.string().min(1).max(300) }),
  z.object({ type: z.literal("button"), deviceId: z.string().min(1).max(300), button: MobileButton }),
  z.object({ type: z.literal("rotate"), deviceId: z.string().min(1).max(300) }),
]);
export type MobilePanelInput = z.infer<typeof MobilePanelInput>;

/** How the Mobile panel shows a device: an H.264 stream from scrcpy, or screenshots polled when that is unavailable. */
export const MobileStreamInfo = z.object({
  deviceId: z.string(),
  mode: z.enum(["video", "stills"]),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  /** Why the stream fell back to stills, shown to the person. */
  fallbackReason: z.string().max(500).optional(),
});
export type MobileStreamInfo = z.infer<typeof MobileStreamInfo>;

/** What the Mobile panel receives for a device it shows. Video frames are Annex B H.264 for WebCodecs. */
export const MobileStreamEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("info"), info: MobileStreamInfo }),
  z.object({
    type: z.literal("config"),
    deviceId: z.string(),
    codec: z.string().max(100),
    width: z.number().int().nonnegative(),
    height: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("frame"),
    deviceId: z.string(),
    key: z.boolean(),
    timestamp: z.number().nonnegative(),
    data: z.instanceof(Uint8Array),
  }),
  z.object({
    type: z.literal("still"),
    deviceId: z.string(),
    /** Base64 PNG. */
    data: z.string(),
    width: z.number().int().nonnegative(),
    height: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal("ended"), deviceId: z.string(), reason: z.string().max(2_000) }),
]);
export type MobileStreamEvent = z.infer<typeof MobileStreamEvent>;

export const MobileScreenshot = z.object({
  data: z.string(),
  mimeType: z.literal("image/png"),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
});
export type MobileScreenshot = z.infer<typeof MobileScreenshot>;

/** Sent to the renderer when an agent boots or drives a device, so the Mobile panel can show it. */
export const MobileRevealEvent = z.object({ deviceId: z.string().min(1).max(300) });
export type MobileRevealEvent = z.infer<typeof MobileRevealEvent>;

/** Served by the browser control service, under their own action names. Routes allow lowercase letters only. */
export const MOBILE_CONTROL_ACTIONS = [
  "mobileaccess",
  "mobiledevices",
  "mobileboot",
  "mobileshutdown",
  "mobileinstall",
  "mobilelaunch",
  "mobileopenurl",
  "mobilesnapshot",
  "mobiletap",
  "mobileswipe",
  "mobiletype",
  "mobilepress",
  "mobilerotate",
  "mobilescreenshot",
  "mobilelogs",
  "mobilerelease",
] as const;
export const MobileControlAction = z.enum(MOBILE_CONTROL_ACTIONS);
export type MobileControlAction = z.infer<typeof MobileControlAction>;

export const MobileControlTarget = BrowserControlTarget.pick({ worktreeId: true, defaultWorktreeId: true, cwd: true });
export type MobileControlTarget = z.infer<typeof MobileControlTarget>;

const DeviceRef = z.string().trim().min(1).max(300).optional();

export const MobileControlDeviceInput = MobileControlTarget.extend({
  /** A deviceId from mobile_devices. Defaults to the device this agent used last, or the only running one. */
  deviceId: DeviceRef,
});
export type MobileControlDeviceInput = z.infer<typeof MobileControlDeviceInput>;

export const MobileControlBootInput = MobileControlDeviceInput.extend({
  platform: MobilePlatform.optional(),
  /** Start the Android emulator with its own window instead of only in the Mobile panel. */
  window: z.boolean().optional(),
  wipeData: z.boolean().optional(),
});
export type MobileControlBootInput = z.infer<typeof MobileControlBootInput>;

export const MobileControlInstallInput = MobileControlDeviceInput.extend({ path: z.string().min(1).max(4_096) });
export type MobileControlInstallInput = z.infer<typeof MobileControlInstallInput>;

export const MobileControlLaunchInput = MobileControlDeviceInput.extend({
  /** Android package name or iOS bundle id. */
  appId: z
    .string()
    .min(1)
    .max(300)
    .regex(/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.$-]+)?$/u, "Use a package name such as com.example.app."),
  stop: z.boolean().optional(),
});
export type MobileControlLaunchInput = z.infer<typeof MobileControlLaunchInput>;

export const MobileControlOpenUrlInput = MobileControlDeviceInput.extend({ url: z.string().min(1).max(8_192) });
export type MobileControlOpenUrlInput = z.infer<typeof MobileControlOpenUrlInput>;

const Coordinate = z.number().min(0).max(100_000);

export const MobileControlTapInput = MobileControlDeviceInput.extend({
  ref: z
    .string()
    .regex(/^e\d{1,5}$/u, "Use a ref such as e12 from mobile_snapshot.")
    .optional(),
  x: Coordinate.optional(),
  y: Coordinate.optional(),
  longPress: z.boolean().optional(),
}).refine(
  (input) => {
    const partial = (input.x === undefined) !== (input.y === undefined);
    return !partial && (input.ref !== undefined) !== (input.x !== undefined);
  },
  { message: "Pass either ref, or both x and y." },
);
export type MobileControlTapInput = z.infer<typeof MobileControlTapInput>;

export const MobileControlSwipeInput = MobileControlDeviceInput.extend({
  direction: z.enum(["up", "down", "left", "right"]).optional(),
  fromX: Coordinate.optional(),
  fromY: Coordinate.optional(),
  toX: Coordinate.optional(),
  toY: Coordinate.optional(),
  durationMs: z.number().int().min(50).max(10_000).optional(),
}).refine(
  (input) =>
    input.direction !== undefined ||
    [input.fromX, input.fromY, input.toX, input.toY].every((value) => value !== undefined),
  { message: "Pass a direction, or fromX, fromY, toX, and toY." },
);
export type MobileControlSwipeInput = z.infer<typeof MobileControlSwipeInput>;

export const MobileControlTypeInput = MobileControlDeviceInput.extend({
  text: z.string().min(1).max(2_000),
  /** Tap this ref from mobile_snapshot first to focus the field. */
  ref: z
    .string()
    .regex(/^e\d{1,5}$/u)
    .optional(),
});
export type MobileControlTypeInput = z.infer<typeof MobileControlTypeInput>;

export const MobileControlPressInput = MobileControlDeviceInput.extend({ button: MobileButton });
export type MobileControlPressInput = z.infer<typeof MobileControlPressInput>;

export const MobileControlRotateInput = MobileControlDeviceInput.extend({
  orientation: z.enum(["portrait", "landscape", "portrait-reverse", "landscape-reverse"]).optional(),
});
export type MobileControlRotateInput = z.infer<typeof MobileControlRotateInput>;

export const MobileControlLogsInput = MobileControlDeviceInput.extend({
  /** Only lines from this app's process on Android, or its subsystem on iOS. */
  appId: z.string().min(1).max(300).optional(),
  lines: z.number().int().min(1).max(2_000).optional(),
  /** Only lines containing this text, case-insensitive. */
  filter: z.string().min(1).max(200).optional(),
});
export type MobileControlLogsInput = z.infer<typeof MobileControlLogsInput>;

/** Open URL from the Mobile panel: the agent tool's fields without its worktree target. */
export const MobilePanelOpenUrlInput = MobileDeviceIdInput.extend({ url: MobileControlOpenUrlInput.shape.url });
export type MobilePanelOpenUrlInput = z.infer<typeof MobilePanelOpenUrlInput>;

export const MobileOpenUrlResult = z.object({
  /** The localhost port forwarded to an Android device with adb reverse, so the device reaches this computer. */
  reversedPort: z.number().int().min(1).max(65_535).optional(),
});
export type MobileOpenUrlResult = z.infer<typeof MobileOpenUrlResult>;

export const MobilePanelLaunchInput = MobileDeviceIdInput.extend({
  appId: MobileControlLaunchInput.shape.appId,
  stop: MobileControlLaunchInput.shape.stop,
});
export type MobilePanelLaunchInput = z.infer<typeof MobilePanelLaunchInput>;

/** The app id goes into an adb shell command on Android, so it takes the launch input's package name rule. */
export const MobilePanelLogsInput = MobileDeviceIdInput.extend({
  appId: MobileControlLaunchInput.shape.appId.optional(),
  lines: MobileControlLogsInput.shape.lines,
  filter: MobileControlLogsInput.shape.filter,
});
export type MobilePanelLogsInput = z.infer<typeof MobilePanelLogsInput>;

export const MobileLogLines = z.array(z.string()).max(2_000);
/** One element from the device's UI tree. ref is what mobile_tap and mobile_type take. */
export type MobileUiNode = {
  ref: string;
  role: string;
  text?: string;
  label?: string;
  id?: string;
  bounds: { x: number; y: number; width: number; height: number };
  clickable?: boolean;
  focused?: boolean;
  enabled?: boolean;
  checked?: boolean;
  scrollable?: boolean;
};
