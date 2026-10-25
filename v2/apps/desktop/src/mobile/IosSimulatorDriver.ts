import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MobileButton, MobileDeviceState, MobileUiNode } from "@zli-v2/contracts";

import { filterLogLines, pngSize } from "./adb.js";
import {
  type DriverDevice,
  type LogQuery,
  type MobileDriver,
  MobileDriverError,
  type Orientation,
  type Screenshot,
} from "./MobileDriver.js";
import { type ProcessRunner, runChecked } from "./ProcessRunner.js";
import type { UiTree } from "./uiTree.js";

export type IosTools = {
  /** xcrun, present only on macOS with Xcode or its command-line tools. */
  readonly xcrun?: string;
  /** idb, the Facebook iOS Development Bridge client. */
  readonly idb?: string;
};

export type IosDriverDeps = {
  readonly runner: ProcessRunner;
  readonly tools: () => Promise<IosTools>;
  readonly readFile?: (path: string) => Promise<Buffer>;
};

export type SimctlDevice = {
  readonly udid: string;
  readonly name: string;
  readonly state: string;
  readonly runtime: string;
  readonly osVersion: string;
  readonly isAvailable: boolean;
};

/** Parses `xcrun simctl list devices --json`, keeping iOS runtimes and available devices. */
export function parseSimctlDevices(json: string): SimctlDevice[] {
  const parsed = JSON.parse(json) as { devices?: Record<string, unknown> };
  const devices: SimctlDevice[] = [];
  for (const [runtime, list] of Object.entries(parsed.devices ?? {})) {
    const version = /SimRuntime\.iOS-(\d+)-(\d+)(?:-(\d+))?$/u.exec(runtime);
    if (!version || !Array.isArray(list)) continue;
    const osVersion = `iOS ${[version[1], version[2], version[3]].filter(Boolean).join(".")}`;
    for (const entry of list) {
      const device = entry as Record<string, unknown>;
      if (typeof device.udid !== "string" || typeof device.name !== "string") continue;
      devices.push({
        udid: device.udid,
        name: device.name,
        state: typeof device.state === "string" ? device.state : "Shutdown",
        runtime,
        osVersion,
        isAvailable: device.isAvailable !== false,
      });
    }
  }
  return devices.filter((device) => device.isAvailable);
}

export function simctlState(state: string): MobileDeviceState {
  if (state === "Booted") return "online";
  if (state === "Booting") return "booting";
  if (state === "Shutdown") return "shutdown";
  return "offline";
}

type IdbElement = {
  AXLabel?: unknown;
  AXValue?: unknown;
  AXUniqueId?: unknown;
  type?: unknown;
  role?: unknown;
  enabled?: unknown;
  frame?: { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
};

/** Parses `idb ui describe-all --json`. Frames are in points, the unit idb taps take. */
export function parseIdbDescribe(json: string): UiTree {
  const trimmed = json.trim();
  const elements: IdbElement[] = trimmed.startsWith("[")
    ? (JSON.parse(trimmed) as IdbElement[])
    : trimmed
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as IdbElement);
  const nodes: MobileUiNode[] = [];
  for (const element of elements) {
    const frame = element.frame;
    const [x, y, width, height] = [frame?.x, frame?.y, frame?.width, frame?.height].map((value) =>
      typeof value === "number" ? value : Number.NaN,
    ) as [number, number, number, number];
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) continue;
    const type = typeof element.type === "string" ? element.type : "view";
    const label = typeof element.AXLabel === "string" ? element.AXLabel.trim() : "";
    const value = typeof element.AXValue === "string" ? element.AXValue.trim() : "";
    const id = typeof element.AXUniqueId === "string" ? element.AXUniqueId.trim() : "";
    if (type === "Application" && nodes.length === 0 && !label) continue;
    const role = iosRole(type);
    const actionable = ["button", "textfield", "switch", "link", "cell", "tab"].includes(role);
    nodes.push({
      ref: `e${nodes.length + 1}`,
      role,
      bounds: { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) },
      ...(value ? { text: value } : label && role === "text" ? { text: label } : {}),
      ...(label && !(role === "text" && !value) ? { label } : {}),
      ...(id ? { id } : {}),
      ...(actionable ? { clickable: true } : {}),
      ...(element.enabled === false ? { enabled: false } : {}),
    });
  }
  return { nodes, depths: nodes.map(() => 0) };
}

function iosRole(type: string): string {
  const map: Record<string, string> = {
    Button: "button",
    StaticText: "text",
    TextField: "textfield",
    SecureTextField: "textfield",
    TextView: "textfield",
    SearchField: "textfield",
    Switch: "switch",
    Link: "link",
    Image: "image",
    Cell: "cell",
    Tab: "tab",
    Slider: "slider",
    Application: "application",
  };
  return map[type] ?? type.toLowerCase();
}

/** HID usage ids idb sends for keys that have no button. */
const IDB_KEYS: Partial<Record<MobileButton, number>> = {
  enter: 40,
  delete: 42,
  tab: 43,
  dpad_right: 79,
  dpad_left: 80,
  dpad_down: 81,
  dpad_up: 82,
};
const IDB_BUTTONS: Partial<Record<MobileButton, string>> = { home: "HOME", power: "LOCK" };

const IDB_MISSING = "This needs idb. Install it with: brew install facebook/fb/idb-companion && pip3 install fb-idb";

export class IosSimulatorDriver implements MobileDriver {
  readonly platform = "ios" as const;
  readonly #deps: IosDriverDeps;
  /** Boots in progress, so a shutdown can stop simctl waiting for a boot that will not finish. */
  readonly #booting = new Map<string, AbortController>();

  constructor(deps: IosDriverDeps) {
    this.#deps = deps;
  }

  async list(): Promise<DriverDevice[]> {
    const tools = await this.#deps.tools();
    if (!tools.xcrun) return [];
    const result = await this.#deps.runner.run(tools.xcrun, ["simctl", "list", "devices", "--json"], {
      timeoutMs: 30_000,
    });
    if (result.code !== 0) return [];
    return parseSimctlDevices(result.stdout.toString("utf8")).map((device) => ({
      deviceId: `ios:${device.udid}`,
      platform: "ios",
      kind: "simulator",
      name: device.name,
      state: simctlState(device.state),
      osVersion: device.osVersion,
    }));
  }

  async boot(device: DriverDevice, options: { window?: boolean; wipeData?: boolean }): Promise<DriverDevice> {
    const xcrun = await this.#xcrun();
    const udid = udidOf(device);
    if (options.wipeData) await runChecked(this.#deps.runner, xcrun, ["simctl", "erase", udid], { timeoutMs: 120_000 });
    const controller = new AbortController();
    this.#booting.set(udid, controller);
    const { signal } = controller;
    try {
      if (device.state !== "online") {
        const boot = await this.#deps.runner.run(xcrun, ["simctl", "boot", udid], { timeoutMs: 120_000, signal });
        if (signal.aborted) throw new MobileDriverError(`${device.name} was shut down while booting.`, 409);
        // simctl reports an already booted device as an error; that is the state wanted here.
        if (boot.code !== 0 && !/current state: Booted/u.test(boot.stderr))
          throw new MobileDriverError(`The simulator would not boot: ${boot.stderr.trim()}`, 500);
      }
      await runChecked(this.#deps.runner, xcrun, ["simctl", "bootstatus", udid, "-b"], {
        timeoutMs: 300_000,
        signal,
      }).catch((cause: unknown) => {
        if (signal.aborted) throw new MobileDriverError(`${device.name} was shut down while booting.`, 409);
        throw cause;
      });
    } finally {
      if (this.#booting.get(udid) === controller) this.#booting.delete(udid);
    }
    if (options.window)
      await this.#deps.runner.run("open", ["-a", "Simulator", "--args", "-CurrentDeviceUDID", udid], {
        timeoutMs: 30_000,
      });
    return { ...device, state: "online" };
  }

  async shutdown(device: DriverDevice): Promise<void> {
    this.#booting.get(udidOf(device))?.abort();
    const result = await this.#deps.runner.run(await this.#xcrun(), ["simctl", "shutdown", udidOf(device)], {
      timeoutMs: 60_000,
    });
    if (result.code !== 0 && !/current state: Shutdown/u.test(result.stderr))
      throw new MobileDriverError(`The simulator would not shut down: ${result.stderr.trim()}`, 500);
  }

  async install(device: DriverDevice, path: string): Promise<string> {
    if (!/\.app\/?$/iu.test(path))
      throw new MobileDriverError("Simulator installs take a .app bundle built for the simulator, not an .ipa.");
    await this.#simctl(device, ["install", udidOf(this.#online(device)), path], 300_000);
    return "Installed";
  }

  async launch(device: DriverDevice, appId: string, options: { stop?: boolean }): Promise<void> {
    const udid = udidOf(this.#online(device));
    if (options.stop)
      await this.#deps.runner.run(await this.#xcrun(), ["simctl", "terminate", udid, appId], { timeoutMs: 30_000 });
    await this.#simctl(device, ["launch", udid, appId], 60_000);
  }

  async openUrl(device: DriverDevice, url: string): Promise<{ reversedPort?: number }> {
    // The simulator shares the Mac's network, so localhost URLs reach the dev server directly.
    await this.#simctl(device, ["openurl", udidOf(this.#online(device)), url], 60_000);
    return {};
  }

  async snapshot(device: DriverDevice): Promise<UiTree> {
    const output = await this.#idb(device, ["ui", "describe-all", "--json"]);
    return parseIdbDescribe(output);
  }

  async tap(device: DriverDevice, x: number, y: number, longPress: boolean): Promise<void> {
    await this.#idb(device, [
      "ui",
      "tap",
      ...(longPress ? ["--duration", "0.8"] : []),
      String(Math.round(x)),
      String(Math.round(y)),
    ]);
  }

  async swipe(
    device: DriverDevice,
    from: { x: number; y: number },
    to: { x: number; y: number },
    durationMs: number,
  ): Promise<void> {
    await this.#idb(device, [
      "ui",
      "swipe",
      "--duration",
      (durationMs / 1000).toFixed(2),
      ...[from.x, from.y, to.x, to.y].map((value) => String(Math.round(value))),
    ]);
  }

  async type(device: DriverDevice, text: string): Promise<void> {
    await this.#idb(device, ["ui", "text", text]);
  }

  async press(device: DriverDevice, button: MobileButton): Promise<void> {
    const named = IDB_BUTTONS[button];
    if (named) return void (await this.#idb(device, ["ui", "button", named]));
    const key = IDB_KEYS[button];
    if (key !== undefined) return void (await this.#idb(device, ["ui", "key", String(key)]));
    throw new MobileDriverError(
      `iOS has no ${button.replaceAll("_", " ")} button ZLI can press. Use home, power, enter, delete, tab, or an arrow key.`,
    );
  }

  async rotate(_device: DriverDevice, _orientation: Orientation | undefined): Promise<Orientation> {
    throw new MobileDriverError(
      "simctl and idb cannot rotate a simulator. Rotate it in the Simulator app with Command and the arrow keys.",
      501,
    );
  }

  async screenshot(device: DriverDevice): Promise<Screenshot> {
    const udid = udidOf(this.#online(device));
    const dir = await mkdtemp(join(tmpdir(), "zli-sim-"));
    const file = join(dir, "screen.png");
    try {
      await this.#simctl(device, ["io", udid, "screenshot", "--type=png", file], 60_000);
      const data = await (this.#deps.readFile ?? ((path: string) => readFile(path)))(file);
      const size = pngSize(data);
      if (!size) throw new MobileDriverError("The simulator returned an unreadable screenshot.", 502);
      return { data, ...size };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async logs(device: DriverDevice, query: LogQuery): Promise<string[]> {
    const args = ["spawn", udidOf(this.#online(device)), "log", "show", "--last", "5m", "--style", "compact"];
    if (query.appId) {
      if (!/^[A-Za-z0-9_.-]+$/u.test(query.appId))
        throw new MobileDriverError("Use a bundle id such as com.example.app.");
      args.push(
        "--predicate",
        `subsystem BEGINSWITH "${query.appId}" OR process == "${query.appId.split(".").pop() ?? ""}"`,
      );
    }
    return filterLogLines(await this.#simctl(device, args, 60_000), query.filter, query.lines);
  }

  async screenSize(device: DriverDevice): Promise<{ width: number; height: number }> {
    const tools = await this.#deps.tools();
    if (tools.idb) {
      const tree = parseIdbDescribe(await this.#idb(device, ["ui", "describe-all", "--json"]));
      const widest = tree.nodes.reduce<MobileUiNode | undefined>(
        (best, node) =>
          !best || node.bounds.width * node.bounds.height > best.bounds.width * best.bounds.height ? node : best,
        undefined,
      );
      if (widest) return { width: widest.bounds.width, height: widest.bounds.height };
    }
    const shot = await this.screenshot(device);
    return { width: shot.width, height: shot.height };
  }

  async dispose(): Promise<void> {
    // Simulators belong to Xcode and keep running after ZLI quits, like they do after Xcode quits.
  }

  #online(device: DriverDevice): DriverDevice {
    if (device.state !== "online")
      throw new MobileDriverError(`${device.name} is not running. Boot it first with mobile_boot.`, 409);
    return device;
  }

  async #xcrun(): Promise<string> {
    const tools = await this.#deps.tools();
    if (!tools.xcrun) throw new MobileDriverError("iOS Simulator needs a Mac with Xcode installed.", 409);
    return tools.xcrun;
  }

  async #simctl(_device: DriverDevice, args: readonly string[], timeoutMs: number): Promise<string> {
    const result = await runChecked(this.#deps.runner, await this.#xcrun(), ["simctl", ...args], { timeoutMs });
    return result.stdout.toString("utf8");
  }

  async #idb(device: DriverDevice, args: readonly string[]): Promise<string> {
    const tools = await this.#deps.tools();
    if (!tools.idb) throw new MobileDriverError(IDB_MISSING, 409);
    const [group, command, ...rest] = args;
    const result = await runChecked(
      this.#deps.runner,
      tools.idb,
      [group ?? "", command ?? "", "--udid", udidOf(this.#online(device)), ...rest],
      { timeoutMs: 60_000 },
    );
    return result.stdout.toString("utf8");
  }
}

function udidOf(device: DriverDevice): string {
  if (!device.deviceId.startsWith("ios:")) throw new MobileDriverError("This is not an iOS simulator.");
  return device.deviceId.slice("ios:".length);
}
