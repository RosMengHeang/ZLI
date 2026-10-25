import type { MobileButton } from "@zli-v2/contracts";
import type { AvdInfo } from "./AndroidSdk.js";
import {
  ANDROID_KEYCODES,
  ANDROID_ROTATIONS,
  deviceShellCommand,
  filterLogLines,
  freeEmulatorPort,
  inputTextArgument,
  localhostPort,
  parseAdbDevices,
  parseEmuAvdName,
  parseWmSize,
  pngSize,
  repairScreencap,
} from "./adb.js";
import {
  type DriverDevice,
  type LogQuery,
  type MobileDriver,
  MobileDriverError,
  type Orientation,
  type Screenshot,
} from "./MobileDriver.js";
import { type ProcessRunner, type RunningProcess, runChecked } from "./ProcessRunner.js";
import { parseUiAutomatorDump, type UiTree } from "./uiTree.js";

export type AndroidTools = {
  readonly adb?: string;
  readonly emulator?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly avds: readonly AvdInfo[];
};

export type AndroidDriverDeps = {
  readonly runner: ProcessRunner;
  /** Re-read on every call, so tools installed by setup are picked up without a restart. */
  readonly tools: () => Promise<AndroidTools>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
  readonly bootTimeoutMs?: number;
};

const AVD_PREFIX = "android-avd:";
const SERIAL_PREFIX = "android:";

export function androidDeviceId(device: { avdName?: string; serial?: string }): string {
  return device.avdName ? `${AVD_PREFIX}${device.avdName}` : `${SERIAL_PREFIX}${device.serial ?? ""}`;
}

/** Arguments for booting an AVD so it suits a panel stream: no boot animation, no saved snapshot, full network. */
export function emulatorBootArgs(
  avdName: string,
  port: number,
  options: { window?: boolean; wipeData?: boolean },
): string[] {
  return [
    "-avd",
    avdName,
    "-port",
    String(port),
    "-no-snapshot-save",
    "-no-boot-anim",
    "-netdelay",
    "none",
    "-netspeed",
    "full",
    ...(options.window ? [] : ["-no-window"]),
    ...(options.wipeData ? ["-wipe-data"] : []),
  ];
}

export class AndroidDriver implements MobileDriver {
  readonly platform = "android" as const;
  readonly #deps: AndroidDriverDeps;
  readonly #avdNames = new Map<string, string | undefined>();
  readonly #started = new Map<string, RunningProcess>();
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #now: () => number;

  constructor(deps: AndroidDriverDeps) {
    this.#deps = deps;
    this.#sleep = deps.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#now = deps.now ?? Date.now;
  }

  async list(): Promise<DriverDevice[]> {
    const tools = await this.#deps.tools();
    const connected = tools.adb ? await this.#connected(tools.adb, tools.env) : [];
    const devices: DriverDevice[] = [];
    const runningAvds = new Set<string>();
    for (const device of connected) {
      const avdName =
        device.emulator && device.state === "online" ? await this.#avdName(tools, device.serial) : undefined;
      if (avdName) runningAvds.add(avdName);
      const avd = avdName ? tools.avds.find((entry) => entry.name === avdName) : undefined;
      devices.push({
        deviceId: androidDeviceId({ ...(avdName ? { avdName } : {}), serial: device.serial }),
        platform: "android",
        kind: device.emulator ? "emulator" : "physical",
        name: avd?.displayName ?? device.model ?? device.serial,
        state: device.state,
        serial: device.serial,
      });
    }
    for (const avd of tools.avds) {
      if (runningAvds.has(avd.name)) continue;
      devices.push({
        deviceId: androidDeviceId({ avdName: avd.name }),
        platform: "android",
        kind: "emulator",
        name: avd.displayName,
        state: this.#started.has(avd.name) ? "booting" : "shutdown",
      });
    }
    return devices;
  }

  async boot(device: DriverDevice, options: { window?: boolean; wipeData?: boolean }): Promise<DriverDevice> {
    if (device.kind === "physical") throw new MobileDriverError("A physical phone is already on; ZLI cannot boot it.");
    if (device.state === "online") return device;
    const avdName = device.deviceId.startsWith(AVD_PREFIX) ? device.deviceId.slice(AVD_PREFIX.length) : undefined;
    if (!avdName) throw new MobileDriverError("This emulator was not started from an AVD, so ZLI cannot boot it.");
    const tools = await this.#deps.tools();
    if (!tools.emulator)
      throw new MobileDriverError("The Android Emulator is not installed. Run setup in the Mobile panel.", 409);
    const adb = this.#adb(tools);
    let process = this.#started.get(avdName);
    let serial: string;
    if (process) {
      serial = (await this.#serialForAvd(tools, avdName)) ?? "";
    } else {
      const serials = (await this.#connected(adb, tools.env)).map((entry) => entry.serial);
      const port = freeEmulatorPort(serials);
      serial = `emulator-${port}`;
      process = this.#deps.runner.spawn(tools.emulator, emulatorBootArgs(avdName, port, options), { env: tools.env });
      this.#started.set(avdName, process);
      this.#avdNames.set(serial, avdName);
      void process.exited.then(() => {
        if (this.#started.get(avdName) === process) this.#started.delete(avdName);
      });
    }
    let output = "";
    process.onStdout((chunk) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-4_000);
    });
    process.onStderr((chunk) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-4_000);
    });
    let exited = false;
    void process.exited.then(() => {
      exited = true;
    });
    const deadline = this.#now() + (this.#deps.bootTimeoutMs ?? 300_000);
    while (this.#now() < deadline) {
      if (exited) throw new MobileDriverError(`The emulator stopped while booting: ${emulatorFailure(output)}`, 500);
      if (!serial) serial = (await this.#serialForAvd(tools, avdName)) ?? "";
      if (serial) {
        const booted = await this.#deps.runner
          .run(adb, ["-s", serial, "shell", "getprop", "sys.boot_completed"], { env: tools.env, timeoutMs: 10_000 })
          .catch(() => undefined);
        if (booted?.code === 0 && booted.stdout.toString("utf8").trim() === "1") {
          return { ...device, state: "online", serial };
        }
      }
      await this.#sleep(1_000);
    }
    throw new MobileDriverError("The emulator did not finish booting within five minutes.", 504);
  }

  async shutdown(device: DriverDevice): Promise<void> {
    if (device.kind === "physical") throw new MobileDriverError("ZLI does not turn off physical phones.");
    const avdName = device.deviceId.startsWith(AVD_PREFIX) ? device.deviceId.slice(AVD_PREFIX.length) : undefined;
    const process = avdName ? this.#started.get(avdName) : undefined;
    if (device.serial) {
      const tools = await this.#deps.tools();
      await this.#deps.runner
        .run(this.#adb(tools), ["-s", device.serial, "emu", "kill"], { env: tools.env, timeoutMs: 15_000 })
        .catch(() => undefined);
    }
    if (process) {
      const stopped = await Promise.race([process.exited.then(() => true), this.#sleep(20_000).then(() => false)]);
      if (!stopped) process.kill();
    }
  }

  async install(device: DriverDevice, path: string): Promise<string> {
    if (!/\.apk$/iu.test(path))
      throw new MobileDriverError("Android installs take an .apk file. Build one with ./gradlew assembleDebug.");
    const output = await this.#adbRun(device, ["install", "-r", "-t", path], 300_000);
    return output.trim().split(/\r?\n/u).at(-1) ?? "Success";
  }

  async launch(device: DriverDevice, appId: string, options: { stop?: boolean }): Promise<void> {
    const packageName = appId.split("/")[0] ?? appId;
    if (options.stop) await this.#shell(device, ["am", "force-stop", packageName]);
    if (appId.includes("/")) {
      const output = await this.#shell(device, ["am", "start", "-W", "-n", appId]);
      if (/Error:/u.test(output)) throw new MobileDriverError(output.trim());
      return;
    }
    const output = await this.#shell(device, ["monkey", "-p", appId, "-c", "android.intent.category.LAUNCHER", "1"]);
    if (/No activities found|monkey aborted/iu.test(output))
      throw new MobileDriverError(`${appId} is not installed or has no launcher activity.`, 404);
  }

  async openUrl(device: DriverDevice, url: string): Promise<{ reversedPort?: number }> {
    const port = localhostPort(url);
    if (port !== undefined) await this.#adbRun(device, ["reverse", `tcp:${port}`, `tcp:${port}`]);
    const output = await this.#shell(device, ["am", "start", "-W", "-a", "android.intent.action.VIEW", "-d", url]);
    if (/Error:/u.test(output)) throw new MobileDriverError(`No app on the device opens ${url}: ${output.trim()}`, 404);
    return port === undefined ? {} : { reversedPort: port };
  }

  async snapshot(device: DriverDevice): Promise<UiTree> {
    const file = "/data/local/tmp/zli-window.xml";
    let lastError = "";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // uiautomator refuses to dump while the screen is still animating; a short wait usually clears it.
      const dump = await this.#shell(device, ["uiautomator", "dump", "--compressed", file]).catch((cause: unknown) =>
        cause instanceof Error ? cause.message : String(cause),
      );
      if (/dumped to/iu.test(dump)) {
        const xml = await this.#adbRun(device, ["exec-out", "cat", file]);
        return parseUiAutomatorDump(xml);
      }
      lastError = dump.trim();
      await this.#sleep(500);
    }
    throw new MobileDriverError(`The device would not report its screen contents: ${lastError}`, 503);
  }

  async tap(device: DriverDevice, x: number, y: number, longPress: boolean): Promise<void> {
    const px = String(Math.round(x));
    const py = String(Math.round(y));
    await this.#shell(device, longPress ? ["input", "swipe", px, py, px, py, "800"] : ["input", "tap", px, py]);
  }

  async swipe(
    device: DriverDevice,
    from: { x: number; y: number },
    to: { x: number; y: number },
    durationMs: number,
  ): Promise<void> {
    await this.#shell(device, [
      "input",
      "swipe",
      ...[from.x, from.y, to.x, to.y].map((value) => String(Math.round(value))),
      String(Math.round(durationMs)),
    ]);
  }

  async type(device: DriverDevice, text: string): Promise<void> {
    await this.#shell(device, ["input", "text", inputTextArgument(text)]);
  }

  async press(device: DriverDevice, button: MobileButton): Promise<void> {
    await this.#shell(device, ["input", "keyevent", String(ANDROID_KEYCODES[button])]);
  }

  async rotate(device: DriverDevice, orientation: Orientation | undefined): Promise<Orientation> {
    let target = orientation;
    if (!target) {
      const current = Number((await this.#shell(device, ["settings", "get", "system", "user_rotation"])).trim());
      target = current === 1 || current === 3 ? "portrait" : "landscape";
    }
    await this.#shell(device, ["settings", "put", "system", "accelerometer_rotation", "0"]);
    await this.#shell(device, ["settings", "put", "system", "user_rotation", String(ANDROID_ROTATIONS[target])]);
    return target;
  }

  async screenshot(device: DriverDevice): Promise<Screenshot> {
    const tools = await this.#deps.tools();
    const result = await runChecked(
      this.#deps.runner,
      this.#adb(tools),
      ["-s", this.#serial(device), "exec-out", "screencap", "-p"],
      {
        env: tools.env,
        timeoutMs: 30_000,
      },
    );
    const data = repairScreencap(result.stdout);
    const size = pngSize(data);
    if (!size) throw new MobileDriverError("The device returned an unreadable screenshot.", 502);
    return { data, ...size };
  }

  async logs(device: DriverDevice, query: LogQuery): Promise<string[]> {
    const args = ["logcat", "-d", "-v", "threadtime", "-t", String(Math.min(20_000, query.lines * 20))];
    if (query.appId) {
      const pid = (await this.#shell(device, ["pidof", "-s", query.appId]).catch(() => "")).trim();
      if (!/^\d+$/u.test(pid))
        throw new MobileDriverError(`${query.appId} is not running, so it has no logs to show.`, 404);
      args.push(`--pid=${pid}`);
    }
    return filterLogLines(await this.#adbRun(device, args, 30_000), query.filter, query.lines);
  }

  async screenSize(device: DriverDevice): Promise<{ width: number; height: number }> {
    const size = parseWmSize(await this.#shell(device, ["wm", "size"]));
    if (!size) throw new MobileDriverError("The device did not report its screen size.", 502);
    return size;
  }

  async dispose(): Promise<void> {
    const running = [...this.#started.values()];
    this.#started.clear();
    for (const process of running) process.kill();
    await Promise.all(running.map((process) => process.exited));
  }

  /** adb and the serial it should address, for the scrcpy session. */
  async connection(
    device: DriverDevice,
  ): Promise<{ runner: ProcessRunner; adb: string; serial: string; env: NodeJS.ProcessEnv }> {
    const tools = await this.#deps.tools();
    return { runner: this.#deps.runner, adb: this.#adb(tools), serial: this.#serial(device), env: tools.env };
  }

  async #connected(adb: string, env: NodeJS.ProcessEnv) {
    const result = await runChecked(this.#deps.runner, adb, ["devices", "-l"], { env, timeoutMs: 15_000 });
    return parseAdbDevices(result.stdout.toString("utf8"));
  }

  async #avdName(tools: AndroidTools, serial: string): Promise<string | undefined> {
    if (this.#avdNames.has(serial)) return this.#avdNames.get(serial);
    const result = await this.#deps.runner
      .run(this.#adb(tools), ["-s", serial, "emu", "avd", "name"], { env: tools.env, timeoutMs: 10_000 })
      .catch(() => undefined);
    const name = result?.code === 0 ? parseEmuAvdName(result.stdout.toString("utf8")) : undefined;
    if (name) this.#avdNames.set(serial, name);
    return name;
  }

  async #serialForAvd(tools: AndroidTools, avdName: string): Promise<string | undefined> {
    for (const device of await this.#connected(this.#adb(tools), tools.env)) {
      if (device.emulator && (await this.#avdName(tools, device.serial)) === avdName) return device.serial;
    }
    return undefined;
  }

  #adb(tools: AndroidTools): string {
    if (!tools.adb) throw new MobileDriverError("adb is not installed. Run setup in the Mobile panel.", 409);
    return tools.adb;
  }

  #serial(device: DriverDevice): string {
    if (device.state !== "online" || !device.serial)
      throw new MobileDriverError(`${device.name} is not running. Boot it first with mobile_boot.`, 409);
    return device.serial;
  }

  async #adbRun(device: DriverDevice, args: readonly string[], timeoutMs = 60_000): Promise<string> {
    const tools = await this.#deps.tools();
    const result = await runChecked(this.#deps.runner, this.#adb(tools), ["-s", this.#serial(device), ...args], {
      env: tools.env,
      timeoutMs,
    });
    return result.stdout.toString("utf8");
  }

  #shell(device: DriverDevice, args: readonly string[]): Promise<string> {
    return this.#adbRun(device, ["shell", deviceShellCommand(args)]);
  }
}

function emulatorFailure(output: string): string {
  const lines = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /ERROR|FATAL|PANIC|error/u.test(line));
  return (lines.slice(-3).join(" ") || output.trim().slice(-500) || "it gave no reason").slice(0, 1_000);
}
