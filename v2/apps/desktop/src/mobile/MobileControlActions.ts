import {
  MobileControlAction,
  MobileControlBootInput,
  MobileControlDeviceInput,
  MobileControlInstallInput,
  MobileControlLaunchInput,
  MobileControlLogsInput,
  MobileControlOpenUrlInput,
  MobileControlPressInput,
  MobileControlRotateInput,
  MobileControlSwipeInput,
  MobileControlTapInput,
  MobileControlTypeInput,
  type MobileDevice,
  type MobileSettings,
  type MobileSetupStatus,
  type MobileUiNode,
} from "@zli-v2/contracts";

import {
  type BrowserControlDispatch,
  BrowserControlError,
  type BrowserControlWorktree,
  resolveBrowserControlWorktree,
} from "../browser/BrowserControlActions.js";
import { DeviceBusyError, type LeaseOwner } from "./DeviceLeases.js";
import type { DeviceManager } from "./DeviceManager.js";
import { MobileDriverError } from "./MobileDriver.js";
import { centerOf, formatUiTree, type UiTree } from "./uiTree.js";

export type MobileControlHost = {
  manager(): DeviceManager | undefined;
  worktrees(): readonly BrowserControlWorktree[];
  settings(): Promise<MobileSettings>;
  status(): Promise<MobileSetupStatus>;
  /** Shows the Mobile panel with this device. */
  reveal(event: { deviceId: string }): void;
  readonly platform?: NodeJS.Platform;
  /** How long mobile_boot waits before answering that the device is still booting. Agent requests time out near three minutes. */
  readonly bootWaitMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
};

export function isMobileControlAction(action: string): boolean {
  return MobileControlAction.safeParse(action).success;
}

const OFF_MESSAGE =
  "Mobile tools are turned off in ZLI. The person can turn them on in the Mobile panel or in Settings, Integrations.";

/**
 * The zli-mobile agent tools. Every device action takes or renews the calling worktree's lease, so two
 * agents never drive one device at once and a person who takes over in the panel stops agents at once.
 */
export function createMobileControlActions(host: MobileControlHost): BrowserControlDispatch {
  const platform = host.platform ?? process.platform;
  const bootWaitMs = host.bootWaitMs ?? 140_000;
  const sleep =
    host.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const lastDevice = new Map<string, string>();
  const trees = new Map<string, { tree: UiTree; ownerId: string }>();

  const manager = (): DeviceManager => {
    const current = host.manager();
    if (!current) throw new BrowserControlError("ZLI's mobile service is still starting. Try again in a moment.", 503);
    return current;
  };

  const ownerFor = (input: MobileControlDeviceInput): LeaseOwner => {
    const worktree = resolveBrowserControlWorktree(input, host.worktrees(), platform);
    const name = worktree.path.replaceAll("\\", "/").split("/").filter(Boolean).pop() ?? worktree.worktreeId;
    return { ownerId: `agent:${worktree.worktreeId}`, ownerLabel: `The agent in ${name}`, kind: "agent" };
  };

  const pickDevice = async (
    input: MobileControlDeviceInput,
    owner: LeaseOwner,
    options: { needOnline: boolean; platform?: MobileDevice["platform"] },
  ): Promise<MobileDevice> => {
    const devices = await manager().list();
    const requested = input.deviceId ?? lastDevice.get(owner.ownerId);
    if (requested) {
      const device = devices.find((candidate) => candidate.deviceId === requested);
      if (device) return device;
      if (input.deviceId)
        throw new BrowserControlError(`No device ${input.deviceId}. Call mobile_devices to list them.`, 404);
    }
    const eligible = devices.filter(
      (device) =>
        (!options.platform || device.platform === options.platform) &&
        (!options.needOnline || device.state === "online") &&
        (device.lease === null || device.lease.ownerId === owner.ownerId),
    );
    const online = eligible.filter((device) => device.state === "online");
    const choice =
      online[0] ?? (options.needOnline ? undefined : eligible.find((device) => device.kind !== "physical"));
    if (!choice)
      throw new BrowserControlError(
        options.needOnline
          ? "No running device is free. Boot one with mobile_boot, or call mobile_devices to see who holds the others."
          : "No device is available. Call mobile_devices to see what is set up.",
        409,
      );
    return choice;
  };

  const lease = (device: MobileDevice, owner: LeaseOwner) => {
    try {
      manager().acquireForAgent(device.deviceId, owner);
    } catch (cause) {
      if (cause instanceof DeviceBusyError) throw new BrowserControlError(cause.message, 423);
      throw cause;
    }
    lastDevice.set(owner.ownerId, device.deviceId);
  };

  const online = async (input: MobileControlDeviceInput) => {
    const owner = ownerFor(input);
    const device = await pickDevice(input, owner, { needOnline: true });
    if (device.state !== "online")
      throw new BrowserControlError(`${device.name} is ${device.state}. Boot it with mobile_boot first.`, 409);
    lease(device, owner);
    return { owner, device, driver: manager().driverFor(device) };
  };

  const summary = (device: MobileDevice) => ({
    deviceId: device.deviceId,
    platform: device.platform,
    kind: device.kind,
    name: device.name,
    state: device.state,
    ...(device.osVersion ? { osVersion: device.osVersion } : {}),
    heldBy: device.lease ? device.lease.ownerLabel : null,
  });

  const resolveRef = (deviceId: string, ownerId: string, ref: string): MobileUiNode => {
    const stored = trees.get(deviceId);
    if (!stored || stored.ownerId !== ownerId)
      throw new BrowserControlError("Call mobile_snapshot first; refs come from the latest snapshot.", 409);
    const node = stored.tree.nodes.find((candidate) => candidate.ref === ref);
    if (!node) throw new BrowserControlError(`No element ${ref} in the latest snapshot. Take a new snapshot.`, 404);
    return node;
  };

  const run = async (action: MobileControlAction, input: unknown): Promise<unknown> => {
    if (action === "mobileaccess") return { enabled: (await host.settings()).agentTools };
    if (!(await host.settings()).agentTools) throw new BrowserControlError(OFF_MESSAGE, 403);
    switch (action) {
      case "mobiledevices": {
        const parsed = MobileControlDeviceInput.parse(input);
        const owner = ownerFor(parsed);
        const [devices, status] = await Promise.all([manager().list(), host.status()]);
        return {
          devices: devices.map(summary),
          lastUsed: lastDevice.get(owner.ownerId) ?? null,
          android: { ready: status.android.missing.length === 0, missing: status.android.missing },
          ios: {
            ready: status.ios.supported && status.ios.missing.length === 0,
            missing: status.ios.supported ? status.ios.missing : ["iOS Simulator needs a Mac with Xcode."],
          },
          ...(status.android.missing.length > 0
            ? {
                setup: "Android setup needs the person: ask them to open the Mobile panel and accept the SDK licenses.",
              }
            : {}),
        };
      }
      case "mobileboot": {
        const parsed = MobileControlBootInput.parse(input);
        const owner = ownerFor(parsed);
        const device = await pickDevice(parsed, owner, {
          needOnline: false,
          ...(parsed.platform ? { platform: parsed.platform } : {}),
        });
        lease(device, owner);
        host.reveal({ deviceId: device.deviceId });
        const boot = manager().boot(device.deviceId, {
          ...(parsed.window !== undefined ? { window: parsed.window } : {}),
          ...(parsed.wipeData !== undefined ? { wipeData: parsed.wipeData } : {}),
        });
        const finished = await Promise.race([
          boot.then((booted) => ({ booted })),
          sleep(bootWaitMs).then(() => undefined),
        ]);
        if (finished) return { device: summary(finished.booted) };
        // The boot keeps going; a later mobile_boot call waits on the same emulator process.
        boot.catch(() => undefined);
        return {
          device: summary({ ...device, state: "booting" }),
          booting: true,
          message: "The device is still booting. Call mobile_boot again with the same deviceId to keep waiting.",
        };
      }
      case "mobileshutdown": {
        const parsed = MobileControlDeviceInput.parse(input);
        const owner = ownerFor(parsed);
        const device = await pickDevice(parsed, owner, { needOnline: true });
        lease(device, owner);
        await manager().shutdown(device.deviceId);
        lastDevice.delete(owner.ownerId);
        return { shutdown: device.deviceId };
      }
      case "mobileinstall": {
        const parsed = MobileControlInstallInput.parse(input);
        const { device, driver } = await online(parsed);
        return { deviceId: device.deviceId, result: await driver.install(device, parsed.path) };
      }
      case "mobilelaunch": {
        const parsed = MobileControlLaunchInput.parse(input);
        const { device, driver } = await online(parsed);
        await driver.launch(device, parsed.appId, parsed.stop ? { stop: true } : {});
        host.reveal({ deviceId: device.deviceId });
        return { deviceId: device.deviceId, launched: parsed.appId };
      }
      case "mobileopenurl": {
        const parsed = MobileControlOpenUrlInput.parse(input);
        const { device, driver } = await online(parsed);
        const result = await driver.openUrl(device, parsed.url);
        host.reveal({ deviceId: device.deviceId });
        return { deviceId: device.deviceId, opened: parsed.url, ...result };
      }
      case "mobilesnapshot": {
        const parsed = MobileControlDeviceInput.parse(input);
        const { owner, device, driver } = await online(parsed);
        const tree = await driver.snapshot(device);
        trees.set(device.deviceId, { tree, ownerId: owner.ownerId });
        const size = await driver.screenSize(device).catch(() => undefined);
        return {
          deviceId: device.deviceId,
          platform: device.platform,
          ...(size ? { screen: size } : {}),
          units: device.platform === "ios" ? "points" : "pixels",
          elements: tree.nodes.length,
          tree: formatUiTree(tree) || "(The screen has no elements to act on.)",
        };
      }
      case "mobiletap": {
        const parsed = MobileControlTapInput.parse(input);
        const { owner, device, driver } = await online(parsed);
        const point = parsed.ref
          ? centerOf(resolveRef(device.deviceId, owner.ownerId, parsed.ref))
          : { x: parsed.x as number, y: parsed.y as number };
        await driver.tap(device, point.x, point.y, parsed.longPress === true);
        return { deviceId: device.deviceId, tapped: point, ...(parsed.ref ? { ref: parsed.ref } : {}) };
      }
      case "mobileswipe": {
        const parsed = MobileControlSwipeInput.parse(input);
        const { device, driver } = await online(parsed);
        let from: { x: number; y: number };
        let to: { x: number; y: number };
        if (parsed.direction) {
          const size = await driver.screenSize(device);
          ({ from, to } = swipeForDirection(parsed.direction, size));
        } else {
          from = { x: parsed.fromX as number, y: parsed.fromY as number };
          to = { x: parsed.toX as number, y: parsed.toY as number };
        }
        await driver.swipe(device, from, to, parsed.durationMs ?? 300);
        return { deviceId: device.deviceId, from, to };
      }
      case "mobiletype": {
        const parsed = MobileControlTypeInput.parse(input);
        const { owner, device, driver } = await online(parsed);
        if (parsed.ref) {
          const point = centerOf(resolveRef(device.deviceId, owner.ownerId, parsed.ref));
          await driver.tap(device, point.x, point.y, false);
        }
        await driver.type(device, parsed.text);
        return { deviceId: device.deviceId, typed: parsed.text.length };
      }
      case "mobilepress": {
        const parsed = MobileControlPressInput.parse(input);
        const { device, driver } = await online(parsed);
        await driver.press(device, parsed.button);
        return { deviceId: device.deviceId, pressed: parsed.button };
      }
      case "mobilerotate": {
        const parsed = MobileControlRotateInput.parse(input);
        const { device, driver } = await online(parsed);
        return { deviceId: device.deviceId, orientation: await driver.rotate(device, parsed.orientation) };
      }
      case "mobilescreenshot": {
        const parsed = MobileControlDeviceInput.parse(input);
        const { device, driver } = await online(parsed);
        const shot = await driver.screenshot(device);
        return {
          deviceId: device.deviceId,
          name: device.name,
          mimeType: "image/png",
          width: shot.width,
          height: shot.height,
          data: shot.data.toString("base64"),
        };
      }
      case "mobilelogs": {
        const parsed = MobileControlLogsInput.parse(input);
        const { device, driver } = await online(parsed);
        const lines = await driver.logs(device, {
          lines: parsed.lines ?? 200,
          ...(parsed.appId ? { appId: parsed.appId } : {}),
          ...(parsed.filter ? { filter: parsed.filter } : {}),
        });
        return { deviceId: device.deviceId, lines: lines.length, log: lines.join("\n") };
      }
      case "mobilerelease": {
        const parsed = MobileControlDeviceInput.parse(input);
        const owner = ownerFor(parsed);
        const released = manager()
          .leases.heldBy(owner.ownerId)
          .filter((deviceId) => !parsed.deviceId || deviceId === parsed.deviceId)
          .filter((deviceId) => manager().leases.release(deviceId, owner.ownerId));
        return { released };
      }
    }
  };

  return async (action, input) => {
    const parsed = MobileControlAction.safeParse(action);
    if (!parsed.success) throw new BrowserControlError(`Unknown mobile action ${action}.`, 404);
    try {
      return await run(parsed.data, input);
    } catch (cause) {
      if (cause instanceof MobileDriverError) throw new BrowserControlError(cause.message, cause.status);
      throw cause;
    }
  };
}

/** A swipe across the middle 50% of the screen. "up" moves the finger up, which scrolls content down. */
export function swipeForDirection(
  direction: "up" | "down" | "left" | "right",
  size: { width: number; height: number },
): { from: { x: number; y: number }; to: { x: number; y: number } } {
  const cx = Math.round(size.width / 2);
  const cy = Math.round(size.height / 2);
  const dy = Math.round(size.height / 4);
  const dx = Math.round(size.width / 4);
  switch (direction) {
    case "up":
      return { from: { x: cx, y: cy + dy }, to: { x: cx, y: cy - dy } };
    case "down":
      return { from: { x: cx, y: cy - dy }, to: { x: cx, y: cy + dy } };
    case "left":
      return { from: { x: cx + dx, y: cy }, to: { x: cx - dx, y: cy } };
    case "right":
      return { from: { x: cx - dx, y: cy }, to: { x: cx + dx, y: cy } };
  }
}
