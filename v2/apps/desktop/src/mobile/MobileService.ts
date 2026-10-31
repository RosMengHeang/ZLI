import { join } from "node:path";

import type { MobileIosStatus, MobileSetupProgress, MobileSetupStatus } from "@zli-v2/contracts";

import { AndroidDriver, type AndroidTools, androidDeviceId } from "./AndroidDriver.js";
import { avdHome, detectAndroidSdk, listAvds, toolProbe } from "./AndroidSdk.js";
import { AndroidEnvironment, AndroidSetup, sdkToolEnv, zliSdkRoot } from "./AndroidSetup.js";
import { AvdManager } from "./AvdManager.js";
import { DeviceManager, type DeviceManagerEvents } from "./DeviceManager.js";
import { downloadVerified, type FetchLike } from "./download.js";
import {
  findOnPath,
  type HostArch,
  type HostOs,
  type MobileFileSystem,
  nodeMobileFileSystem,
  pathFor,
} from "./host.js";
import { IosSimulatorDriver, type IosTools } from "./IosSimulatorDriver.js";
import { iosVideoEnabled } from "./IosVideoSource.js";
import { createNodeProcessRunner, type ProcessRunner } from "./ProcessRunner.js";
import { SCRCPY_SERVER_SHA256, SCRCPY_SERVER_URL, SCRCPY_VERSION } from "./scrcpy/protocol.js";

export type MobileServiceOptions = {
  readonly os: HostOs;
  readonly arch: HostArch;
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
  /** ZLI's own folder for mobile downloads. */
  readonly mobileDir: string;
  readonly runner?: ProcessRunner;
  readonly fs?: MobileFileSystem;
  readonly fetch?: FetchLike;
  readonly events?: DeviceManagerEvents & { setup?: (progress: MobileSetupProgress) => void };
};

/** Apps started from the macOS Finder get a short PATH, so the places Homebrew and pip put tools are searched too. */
export async function iosToolSearchDirs(home: string, fs: MobileFileSystem): Promise<string[]> {
  const pythonRoot = join(home, "Library", "Python");
  const pythonBins = (await fs.readdir(pythonRoot)).map((version) => join(pythonRoot, version, "bin"));
  return ["/opt/homebrew/bin", "/usr/local/bin", join(home, ".local", "bin"), ...pythonBins];
}

export async function detectIosTools(options: {
  os: HostOs;
  env: NodeJS.ProcessEnv;
  home: string;
  fs: MobileFileSystem;
  runner: ProcessRunner;
}): Promise<{ tools: IosTools; status: MobileIosStatus }> {
  if (options.os !== "macos") {
    return {
      tools: {},
      status: { supported: false, simctl: { found: false }, idb: { found: false }, missing: ["A Mac with Xcode"] },
    };
  }
  const xcrun = (await options.fs.exists("/usr/bin/xcrun")) ? "/usr/bin/xcrun" : undefined;
  let simctl = false;
  if (xcrun) {
    const result = await options.runner.run(xcrun, ["simctl", "help"], { timeoutMs: 20_000 }).catch(() => undefined);
    simctl = result?.code === 0;
  }
  const searchPath = [options.env.PATH ?? "", ...(await iosToolSearchDirs(options.home, options.fs))].join(":");
  const idb = await findOnPath("idb", { PATH: searchPath }, "macos", options.fs);
  const osascript = (await options.fs.exists("/usr/bin/osascript")) ? "/usr/bin/osascript" : undefined;
  const missing: string[] = [];
  if (!simctl) missing.push("Xcode with the iOS Simulator (install Xcode from the App Store, then open it once)");
  if (!idb)
    missing.push(
      "idb, for taps, typing, and reading the screen (brew install facebook/fb/idb-companion and pip3 install fb-idb)",
    );
  return {
    tools: { ...(simctl && xcrun ? { xcrun } : {}), ...(idb ? { idb } : {}), ...(osascript ? { osascript } : {}) },
    status: {
      supported: true,
      simctl: simctl && xcrun ? toolProbe(xcrun) : { found: false },
      idb: toolProbe(idb),
      missing,
    },
  };
}

export type MobileService = {
  readonly manager: DeviceManager;
  readonly setup: AndroidSetup;
  readonly environment: AndroidEnvironment;
  readonly avds: AvdManager;
  status(options?: { recheckAcceleration?: boolean }): Promise<MobileSetupStatus>;
  dispose(): Promise<void>;
};

const TOOL_CACHE_MS = 3_000;

/** Wires the mobile pieces together. Has no Electron dependency, so it runs in tests as is. */
export function createMobileService(options: MobileServiceOptions): MobileService {
  const runner = options.runner ?? createNodeProcessRunner();
  const fs = options.fs ?? nodeMobileFileSystem;
  const fetchLike = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const environment = new AndroidEnvironment({
    os: options.os,
    arch: options.arch,
    env: options.env,
    home: options.home,
    mobileDir: options.mobileDir,
    fs,
    runner,
  });

  let androidTools: { at: number; value: Promise<AndroidTools> } | undefined;
  const resolveAndroidTools = (): Promise<AndroidTools> => {
    if (androidTools && Date.now() - androidTools.at < TOOL_CACHE_MS) return androidTools.value;
    const value = (async () => {
      const layout = await detectAndroidSdk({
        os: options.os,
        env: options.env,
        home: options.home,
        zliSdkRoot: zliSdkRoot(options),
        fs,
      });
      const avds = await listAvds(avdHome(options.os, options.home, options.env), options.os, fs);
      return {
        ...(layout.adb ? { adb: layout.adb } : {}),
        ...(layout.emulator ? { emulator: layout.emulator } : {}),
        env: sdkToolEnv(options.env, options.os, layout.root, undefined),
        avds,
      };
    })();
    androidTools = { at: Date.now(), value };
    return value;
  };

  let iosTools: { at: number; value: ReturnType<typeof detectIosTools> } | undefined;
  const resolveIos = () => {
    if (iosTools && Date.now() - iosTools.at < TOOL_CACHE_MS * 10) return iosTools.value;
    const value = detectIosTools({ os: options.os, env: options.env, home: options.home, fs, runner });
    iosTools = { at: Date.now(), value };
    return value;
  };

  const scrcpyServerPath = pathFor(options.os).join(options.mobileDir, `scrcpy-server-v${SCRCPY_VERSION}`);
  let scrcpyDownload: Promise<string> | undefined;
  const scrcpyServer = (): Promise<string> => {
    scrcpyDownload ??= (async () => {
      if (await fs.exists(scrcpyServerPath)) return scrcpyServerPath;
      return downloadVerified({
        url: SCRCPY_SERVER_URL,
        destination: scrcpyServerPath,
        algorithm: "sha256",
        checksum: SCRCPY_SERVER_SHA256,
        fetch: fetchLike,
      });
    })().catch((cause: unknown) => {
      scrcpyDownload = undefined;
      throw cause;
    });
    return scrcpyDownload;
  };

  const ios = new IosSimulatorDriver({ runner, tools: async () => (await resolveIos()).tools });
  const manager = new DeviceManager({
    android: new AndroidDriver({ runner, tools: resolveAndroidTools }),
    ios,
    scrcpyServer,
    ...(iosVideoEnabled(options.env) ? { iosVideo: (device, handlers) => ios.startVideo(device, handlers) } : {}),
    ...(options.events ? { events: options.events } : {}),
  });

  const setup = new AndroidSetup({
    environment,
    fetch: fetchLike,
    onProgress: (progress) => {
      if (progress.state !== "running") {
        androidTools = undefined;
        void manager.list();
      }
      options.events?.setup?.(progress);
    },
  });

  const avds = new AvdManager({
    environment,
    isRunning: async (name) => {
      const deviceId = androidDeviceId({ avdName: name });
      return (await manager.list()).some((device) => device.deviceId === deviceId && device.state !== "shutdown");
    },
    onChange: async () => {
      androidTools = undefined;
      await manager.list();
    },
    setupRunning: () => setup.running,
  });

  return {
    manager,
    setup,
    environment,
    avds,
    status: async (statusOptions = {}) => {
      const [android, ios] = await Promise.all([environment.inspect(statusOptions), resolveIos()]);
      return { host: { os: options.os, arch: options.arch }, android: android.status, ios: ios.status };
    },
    dispose: async () => {
      setup.cancel();
      await manager.dispose();
    },
  };
}
