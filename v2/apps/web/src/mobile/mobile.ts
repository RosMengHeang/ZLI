import type {
  MobileAndroidStatus,
  MobileButton,
  MobileDevice,
  MobileDeviceState,
  MobilePanelInput,
  MobileSetupPlan,
  MobileSetupProgress,
} from "@zli-v2/contracts";

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

/** What the panel says about who holds a device, or nothing when it is free. */
export function leaseNotice(
  device: Pick<MobileDevice, "lease">,
): { kind: "agent" | "person"; text: string } | undefined {
  const lease = device.lease;
  if (!lease) return undefined;
  if (lease.kind === "person")
    return { kind: "person", text: "You have control. Agents cannot use this device until you hand it back." };
  return {
    kind: "agent",
    text: `${lease.ownerLabel || "An agent"} is using this device. Take over to use it yourself.`,
  };
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

const KEY_BUTTONS: Record<string, MobileButton> = { Enter: "enter", Backspace: "delete", Escape: "back" };

/** The device input for a key pressed while the screen has focus. Shortcuts with Ctrl, Cmd, or Alt stay with ZLI. */
export function keyInput(
  deviceId: string,
  event: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean },
): MobilePanelInput | undefined {
  if (event.ctrlKey || event.metaKey || event.altKey) return undefined;
  const button = KEY_BUTTONS[event.key];
  if (button) return { deviceId, type: "button", button };
  if ([...event.key].length === 1) return { deviceId, type: "text", text: event.key };
  return undefined;
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

export function androidNeedsInstall(android: MobileAndroidStatus): boolean {
  return !android.adb.found || !android.emulator.found || android.avds.length === 0;
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
