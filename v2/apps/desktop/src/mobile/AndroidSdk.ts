import type { MobileAndroidStatus, MobileToolProbe } from "@zli-v2/contracts";

import { executableName, findOnPath, type HostOs, type MobileFileSystem, pathFor } from "./host.js";
import type { ProcessRunner } from "./ProcessRunner.js";

export type AndroidSdkSource = MobileAndroidStatus["sdkSource"];

export type AndroidSdkLayout = {
  readonly root: string;
  readonly source: AndroidSdkSource;
  readonly adb?: string;
  readonly emulator?: string;
  readonly sdkmanager?: string;
  readonly avdmanager?: string;
};

export type AndroidSdkDetectOptions = {
  readonly os: HostOs;
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
  /** Where ZLI installs an SDK of its own when the person has none. */
  readonly zliSdkRoot: string;
  readonly fs: MobileFileSystem;
};

export function defaultSdkRoots(os: HostOs, home: string, env: NodeJS.ProcessEnv): string[] {
  const path = pathFor(os);
  if (os === "macos") return [path.join(home, "Library", "Android", "sdk")];
  if (os === "windows") {
    const localAppData = env.LOCALAPPDATA?.trim() || path.join(home, "AppData", "Local");
    return [path.join(localAppData, "Android", "Sdk")];
  }
  return [path.join(home, "Android", "Sdk"), path.join(home, "Android", "sdk")];
}

/**
 * Finds the Android SDK the way Android Studio and the SDK tools do: ANDROID_HOME, then the deprecated
 * ANDROID_SDK_ROOT, then the default install location, then the copy ZLI installs itself.
 */
export async function detectAndroidSdk(options: AndroidSdkDetectOptions): Promise<AndroidSdkLayout> {
  const { os, env, fs } = options;
  const candidates: Array<{ root: string; source: AndroidSdkSource }> = [
    ...[env.ANDROID_HOME, env.ANDROID_SDK_ROOT]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value))
      .map((root) => ({ root, source: "env" as const })),
    ...defaultSdkRoots(os, options.home, env).map((root) => ({ root, source: "default" as const })),
    { root: options.zliSdkRoot, source: "zli" },
  ];
  let chosen: { root: string; source: AndroidSdkSource } | undefined;
  for (const candidate of candidates) {
    if (await looksLikeSdk(candidate.root, os, fs)) {
      chosen = candidate;
      break;
    }
  }
  const root = chosen?.root ?? options.zliSdkRoot;
  const path = pathFor(os);
  const adbInSdk = path.join(root, "platform-tools", executableName("adb", os));
  const emulator = path.join(root, "emulator", executableName("emulator", os));
  const adb = (await fs.exists(adbInSdk)) ? adbInSdk : await findOnPath("adb", env, os, fs);
  const sdkmanager = await findCmdlineTool(root, "sdkmanager", os, fs);
  const avdmanager = await findCmdlineTool(root, "avdmanager", os, fs);
  return {
    root,
    source: chosen?.source ?? "none",
    ...(adb ? { adb } : {}),
    ...((await fs.exists(emulator)) ? { emulator } : {}),
    ...(sdkmanager ? { sdkmanager } : {}),
    ...(avdmanager ? { avdmanager } : {}),
  };
}

async function looksLikeSdk(root: string, os: HostOs, fs: MobileFileSystem): Promise<boolean> {
  if (!(await fs.isDirectory(root))) return false;
  const path = pathFor(os);
  for (const child of ["platform-tools", "cmdline-tools", "emulator", "tools"]) {
    if (await fs.isDirectory(path.join(root, child))) return true;
  }
  return false;
}

/** cmdline-tools/latest wins, then the newest versioned folder, then the old tools/bin layout. */
async function findCmdlineTool(
  root: string,
  name: "sdkmanager" | "avdmanager",
  os: HostOs,
  fs: MobileFileSystem,
): Promise<string | undefined> {
  const path = pathFor(os);
  const file = executableName(name, os, ".bat");
  const versions = (await fs.readdir(path.join(root, "cmdline-tools")))
    .filter((entry) => entry !== "latest")
    .sort(compareVersionsDescending);
  const dirs = [
    path.join(root, "cmdline-tools", "latest"),
    ...versions.map((entry) => path.join(root, "cmdline-tools", entry)),
    path.join(root, "tools"),
  ];
  for (const dir of dirs) {
    const candidate = path.join(dir, "bin", file);
    if (await fs.exists(candidate)) return candidate;
  }
  return undefined;
}

function compareVersionsDescending(left: string, right: string): number {
  const parts = (value: string) => value.split(/[.-]/u).map((part) => Number.parseInt(part, 10) || 0);
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (b[index] ?? 0) - (a[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Installed system images as sdkmanager package ids, such as system-images;android-35;google_apis;x86_64. */
export async function listSystemImages(root: string, os: HostOs, fs: MobileFileSystem): Promise<string[]> {
  const path = pathFor(os);
  const base = path.join(root, "system-images");
  const images: string[] = [];
  for (const api of await fs.readdir(base)) {
    for (const tag of await fs.readdir(path.join(base, api))) {
      for (const abi of await fs.readdir(path.join(base, api, tag))) {
        const dir = path.join(base, api, tag, abi);
        if ((await fs.exists(path.join(dir, "system.img"))) || (await fs.exists(path.join(dir, "package.xml"))))
          images.push(`system-images;${api};${tag};${abi}`);
      }
    }
  }
  return images.sort();
}

/** The folder the emulator reads AVDs from, following the same variables it does. */
export function avdHome(os: HostOs, home: string, env: NodeJS.ProcessEnv): string {
  const path = pathFor(os);
  const explicit = env.ANDROID_AVD_HOME?.trim();
  if (explicit) return explicit;
  const userHome = env.ANDROID_USER_HOME?.trim() || env.ANDROID_EMULATOR_HOME?.trim();
  if (userHome) return path.join(userHome, "avd");
  return path.join(home, ".android", "avd");
}

export type AvdInfo = { readonly name: string; readonly displayName: string; readonly systemImage?: string };

export async function listAvds(directory: string, os: HostOs, fs: MobileFileSystem): Promise<AvdInfo[]> {
  const path = pathFor(os);
  const avds: AvdInfo[] = [];
  for (const entry of (await fs.readdir(directory)).sort()) {
    if (!entry.endsWith(".ini")) continue;
    const name = entry.slice(0, -".ini".length);
    let displayName = name.replaceAll("_", " ");
    let systemImage: string | undefined;
    try {
      const pointer = parseIni(await fs.readFile(path.join(directory, entry)));
      const avdPath = pointer.path ?? path.join(directory, `${name}.avd`);
      const config = parseIni(await fs.readFile(path.join(avdPath, "config.ini")));
      if (config["avd.ini.displayname"]) displayName = config["avd.ini.displayname"];
      const sysdir = config["image.sysdir.1"];
      if (sysdir)
        systemImage = sysdir
          .replace(/[\\/]+$/u, "")
          .split(/[\\/]/u)
          .join(";");
    } catch {
      // An AVD whose files are unreadable is still listed by name; booting it reports the real problem.
    }
    avds.push({ name, displayName, ...(systemImage ? { systemImage } : {}) });
  }
  return avds;
}

export function parseIni(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/u)) {
    const match = /^\s*([^#=][^=]*?)\s*=\s*(.*?)\s*$/u.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) values[match[1]] = match[2];
  }
  return values;
}

export type JavaRuntime = { readonly path: string; readonly version: string; readonly major: number };

export type JavaDetectOptions = {
  readonly os: HostOs;
  readonly env: NodeJS.ProcessEnv;
  /** Folder ZLI extracts its own Java runtime into. */
  readonly zliJreRoot: string;
  readonly fs: MobileFileSystem;
  readonly runner: ProcessRunner;
};

export const MIN_JAVA_MAJOR = 17;

/** Candidate java executables in the order the SDK tools would pick them, plus Android Studio's bundled runtime. */
export async function javaCandidates(options: Omit<JavaDetectOptions, "runner">): Promise<string[]> {
  const { os, env, fs } = options;
  const path = pathFor(os);
  const java = executableName("java", os);
  const candidates: string[] = [];
  const javaHome = env.JAVA_HOME?.trim();
  if (javaHome) candidates.push(path.join(javaHome, "bin", java));
  for (const entry of await fs.readdir(options.zliJreRoot)) {
    candidates.push(path.join(options.zliJreRoot, entry, "bin", java));
    candidates.push(path.join(options.zliJreRoot, entry, "Contents", "Home", "bin", java));
  }
  if (os === "macos") {
    candidates.push("/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/java");
  } else if (os === "windows") {
    const programFiles = env.ProgramFiles?.trim() || "C:\\Program Files";
    candidates.push(path.join(programFiles, "Android", "Android Studio", "jbr", "bin", java));
  } else {
    candidates.push("/opt/android-studio/jbr/bin/java", "/usr/local/android-studio/jbr/bin/java");
  }
  const onPath = await findOnPath("java", env, os, fs);
  if (onPath) candidates.push(onPath);
  const existing: string[] = [];
  for (const candidate of candidates)
    if (!existing.includes(candidate) && (await fs.exists(candidate))) existing.push(candidate);
  return existing;
}

/** The first Java new enough for the SDK tools, or the newest one found when none is. */
export async function detectJava(options: JavaDetectOptions): Promise<JavaRuntime | undefined> {
  let best: JavaRuntime | undefined;
  for (const candidate of await javaCandidates(options)) {
    const result = await options.runner.run(candidate, ["-version"], { timeoutMs: 15_000 }).catch(() => undefined);
    if (result?.code !== 0) continue;
    const version = parseJavaVersion(`${result.stderr}\n${result.stdout.toString("utf8")}`);
    if (!version) continue;
    const runtime = { path: candidate, ...version };
    if (runtime.major >= MIN_JAVA_MAJOR) return runtime;
    if (!best || runtime.major > best.major) best = runtime;
  }
  return best;
}

export function parseJavaVersion(output: string): { version: string; major: number } | undefined {
  const match = /version "([^"]+)"/u.exec(output);
  if (!match?.[1]) return undefined;
  const version = match[1];
  const parts = version.split(/[._+-]/u);
  const first = Number.parseInt(parts[0] ?? "", 10);
  if (!Number.isFinite(first)) return undefined;
  const major = first === 1 ? Number.parseInt(parts[1] ?? "", 10) : first;
  return Number.isFinite(major) ? { version, major } : undefined;
}

export type AccelerationCheck = MobileAndroidStatus["acceleration"];

/** `emulator -accel-check` exits 0 only when KVM, the Hypervisor framework, WHPX, or AEHD is usable. */
export async function checkAcceleration(
  runner: ProcessRunner,
  emulator: string | undefined,
): Promise<AccelerationCheck> {
  if (!emulator) return { checked: false, usable: false, detail: "The Android Emulator is not installed yet." };
  const result = await runner.run(emulator, ["-accel-check"], { timeoutMs: 30_000 }).catch((cause: unknown) => ({
    code: -1,
    stdout: Buffer.alloc(0),
    stderr: cause instanceof Error ? cause.message : String(cause),
    timedOut: false,
  }));
  return {
    checked: true,
    usable: result.code === 0,
    detail: parseAccelCheck(result.stdout.toString("utf8"), result.stderr),
  };
}

export function parseAccelCheck(stdout: string, stderr = ""): string {
  const lines = `${stdout}\n${stderr}`
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && line !== "accel:" && line !== "accel" && !/^\d+$/u.test(line));
  return lines.join(" ").slice(0, 2_000) || "The emulator did not explain its acceleration check.";
}

export function toolProbe(path: string | undefined, version?: string): MobileToolProbe {
  return path ? { found: true, path, ...(version ? { version } : {}) } : { found: false };
}

export type AndroidStatusInput = {
  readonly layout: AndroidSdkLayout;
  readonly java: JavaRuntime | undefined;
  readonly systemImages: readonly string[];
  readonly avds: readonly AvdInfo[];
  readonly acceleration: AccelerationCheck;
};

export function androidStatus(input: AndroidStatusInput): MobileAndroidStatus {
  const { layout, java } = input;
  const missing: string[] = [];
  if (!layout.adb) missing.push("Android platform tools (adb)");
  if (!layout.emulator) missing.push("Android Emulator");
  if (input.systemImages.length === 0) missing.push("An Android system image");
  if (input.avds.length === 0) missing.push("A virtual device (AVD)");
  if (missing.length > 0 && !layout.sdkmanager) missing.push("Android SDK command-line tools");
  const javaUsable = java !== undefined && java.major >= MIN_JAVA_MAJOR;
  if (missing.length > 0 && !javaUsable) missing.push(`Java ${MIN_JAVA_MAJOR} or newer, which the SDK tools run on`);
  if (input.acceleration.checked && !input.acceleration.usable) missing.push("Hardware acceleration for the emulator");
  return {
    ...(layout.source === "none" ? {} : { sdkRoot: layout.root }),
    sdkSource: layout.source,
    adb: toolProbe(layout.adb),
    emulator: toolProbe(layout.emulator),
    sdkmanager: toolProbe(layout.sdkmanager),
    avdmanager: toolProbe(layout.avdmanager),
    java: java ? { found: javaUsable, path: java.path, version: java.version } : { found: false },
    systemImages: [...input.systemImages],
    avds: input.avds.map((avd) => avd.name),
    acceleration: input.acceleration,
    missing,
  };
}
