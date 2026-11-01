import type { MobileClientKind, MobilePackageManager, MobileProjectFactsCore } from "@zli-v2/contracts";

import { type HostOs, type MobileFileSystem, pathFor } from "../../host.js";

type Stack = MobileProjectFactsCore["stack"];

/** What the files of one app say about it. Nothing here runs a process or the project's code. */
export type ProjectRead = {
  /** Relative to the worktree, "." for its root. */
  appDir: string;
  stack: Stack;
  /** Versions the project itself declares, such as expo, react-native, gradle, and agp. */
  versions: Record<string, string>;
  dependencies: ReadonlySet<string>;
  devClient: boolean;
  packageManager: MobilePackageManager | undefined;
  client: { kind: MobileClientKind; reason: string };
  newArch: { enabled?: boolean; source?: string; disabledIn?: string[] };
  appIds: { android?: string; ios?: string; scheme?: string };
  android:
    | { gradle?: string; agp?: string; kotlin?: string; builtInKotlinOptOut?: boolean; newDslOptOut?: boolean }
    | undefined;
  ios: { podfile: boolean; podsDrift?: boolean; deploymentTarget?: string; developmentTeam?: boolean } | undefined;
  androidSigning: "debug-only" | "release-config" | "eas" | "unknown";
  hasPackageJson: boolean;
  /** Files that exist but could not be parsed, relative to the worktree. */
  unreadable: string[];
};

type Json = Record<string, unknown>;

const SKIPPED_DIRS = new Set(["node_modules", "build", "dist", "Pods", "vendor", "coverage"]);

/**
 * The folder the app lives in: the worktree root when it holds one, else the first app under apps/, packages/, or a
 * top-level folder, so monorepos such as apps/mobile are found.
 */
export async function findAppDir(fs: MobileFileSystem, root: string, os: HostOs): Promise<string | undefined> {
  const path = pathFor(os);
  if (await isAppDir(fs, root, os)) return ".";
  const groups = ["apps", "packages"];
  for (const group of groups) {
    for (const name of (await fs.readdir(path.join(root, group))).sort()) {
      if (name.startsWith(".") || SKIPPED_DIRS.has(name)) continue;
      if (await isAppDir(fs, path.join(root, group, name), os)) return `${group}/${name}`;
    }
  }
  for (const name of (await fs.readdir(root)).sort()) {
    if (name.startsWith(".") || SKIPPED_DIRS.has(name) || groups.includes(name)) continue;
    if (await isAppDir(fs, path.join(root, name), os)) return name;
  }
  return undefined;
}

async function isAppDir(fs: MobileFileSystem, dir: string, os: HostOs): Promise<boolean> {
  const path = pathFor(os);
  const manifest = await readJson(fs, path.join(dir, "package.json"));
  if (manifest && dependencyNames(manifest).some((name) => name === "expo" || name === "react-native")) return true;
  if (await fs.exists(path.join(dir, "pubspec.yaml"))) return true;
  if (await androidDir(fs, dir, os)) return true;
  return (await iosDir(fs, dir, os)) !== undefined;
}

/** The folder with the Gradle build: android/ in React Native, Expo, and Flutter apps, or the root of a native app. */
async function androidDir(fs: MobileFileSystem, dir: string, os: HostOs): Promise<string | undefined> {
  const path = pathFor(os);
  for (const candidate of ["android", "."]) {
    const base = path.join(dir, candidate);
    for (const file of ["settings.gradle", "settings.gradle.kts", "app/build.gradle", "app/build.gradle.kts"]) {
      if (await fs.exists(path.join(base, file))) return candidate;
    }
  }
  return undefined;
}

async function iosDir(fs: MobileFileSystem, dir: string, os: HostOs): Promise<string | undefined> {
  const path = pathFor(os);
  for (const candidate of ["ios", "."]) {
    const entries = await fs.readdir(path.join(dir, candidate));
    if (entries.some((entry) => entry.endsWith(".xcodeproj")) || (candidate === "ios" && entries.includes("Podfile")))
      return candidate;
  }
  return undefined;
}

export async function readProject(fs: MobileFileSystem, root: string, os: HostOs): Promise<ProjectRead | undefined> {
  const appDir = await findAppDir(fs, root, os);
  if (appDir === undefined) return undefined;
  const path = pathFor(os);
  const dir = appDir === "." ? root : path.join(root, ...appDir.split("/"));
  const rel = (...parts: string[]) => (appDir === "." ? parts.join("/") : [appDir, ...parts].join("/"));
  const unreadable: string[] = [];
  const text = (relative: string) => readText(fs, path.join(dir, ...relative.split("/")));
  const json = async (relative: string) => {
    const raw = await text(relative);
    if (raw === undefined) return undefined;
    const parsed = parseJson(raw);
    if (!parsed) unreadable.push(rel(relative));
    return parsed;
  };

  const manifest = await json("package.json");
  const dependencies = new Set(manifest ? dependencyNames(manifest) : []);
  const versions: Record<string, string> = {};
  const lock = await findLockfile(fs, root, dir, os);
  for (const name of ["expo", "react-native", "react"]) {
    if (!dependencies.has(name)) continue;
    const version =
      (lock ? lockedVersion(lock.manager, lock.text, name) : undefined) ??
      (await installedVersion(fs, [dir, root], name, os)) ??
      declaredVersion(manifest, name);
    if (version) versions[name] = version;
  }

  const appJson = ((await json("app.json")) ?? (await json("app.config.json"))) as Json | undefined;
  const expo = (isObject(appJson?.expo) ? appJson.expo : appJson) as Json | undefined;
  const easJson = await text("eas.json");

  const androidRoot = await androidDir(fs, dir, os);
  const gradleProps = androidRoot ? parseProperties((await text(join(androidRoot, "gradle.properties"))) ?? "") : {};
  let android: ProjectRead["android"];
  let androidAppGradle: string | undefined;
  if (androidRoot) {
    const wrapper = (await text(join(androidRoot, "gradle/wrapper/gradle-wrapper.properties"))) ?? "";
    const buildFiles = [
      (await text(join(androidRoot, "build.gradle"))) ?? (await text(join(androidRoot, "build.gradle.kts"))) ?? "",
      (await text(join(androidRoot, "settings.gradle"))) ??
        (await text(join(androidRoot, "settings.gradle.kts"))) ??
        "",
      (await text(join(androidRoot, "gradle/libs.versions.toml"))) ?? "",
    ].join("\n");
    androidAppGradle =
      (await text(join(androidRoot, "app/build.gradle"))) ?? (await text(join(androidRoot, "app/build.gradle.kts")));
    const gradle = /gradle-(\d+(?:\.\d+)+)-(?:bin|all)\.zip/u.exec(wrapper)?.[1];
    const agp = agpVersion(buildFiles);
    const kotlin = kotlinVersion(buildFiles);
    android = {
      ...(gradle ? { gradle } : {}),
      ...(agp ? { agp } : {}),
      ...(kotlin ? { kotlin } : {}),
      ...(gradleProps["android.builtInKotlin"] === "false" ? { builtInKotlinOptOut: true } : {}),
      ...(gradleProps["android.newDsl"] === "false" ? { newDslOptOut: true } : {}),
    };
    if (gradle) versions.gradle = gradle;
    if (agp) versions.agp = agp;
    if (kotlin) versions.kotlin = kotlin;
  }

  const iosRoot = await iosDir(fs, dir, os);
  let ios: ProjectRead["ios"];
  let iosBundle: string | undefined;
  let podsProperties: Json | undefined;
  if (iosRoot) {
    const podfile = await text(join(iosRoot, "Podfile"));
    const podLock = await text(join(iosRoot, "Podfile.lock"));
    const manifestLock = await text(join(iosRoot, "Pods/Manifest.lock"));
    const project = await xcodeProject(fs, path.join(dir, iosRoot), os);
    podsProperties = (await json(join(iosRoot, "Podfile.properties.json"))) as Json | undefined;
    const targets = [...(project ?? "").matchAll(/IPHONEOS_DEPLOYMENT_TARGET = "?([\d.]+)"?;/gu)].map(
      (m) => m[1] ?? "",
    );
    const podTarget = /platform\s+:ios,\s*['"]([\d.]+)['"]/u.exec(podfile ?? "")?.[1];
    const deploymentTarget = targets[0] ?? podTarget;
    iosBundle = [...(project ?? "").matchAll(/PRODUCT_BUNDLE_IDENTIFIER = "?([^";\s]+)"?;/gu)]
      .map((m) => m[1] ?? "")
      .find((id) => !/tests?$/iu.test(id) && !id.includes("$("));
    ios = {
      podfile: podfile !== undefined,
      ...(podLock !== undefined && manifestLock !== undefined
        ? { podsDrift: normalize(podLock) !== normalize(manifestLock) }
        : {}),
      ...(deploymentTarget ? { deploymentTarget } : {}),
      ...(project !== undefined ? { developmentTeam: /DEVELOPMENT_TEAM = "?[A-Z0-9]+"?;/u.test(project) } : {}),
    };
  }

  let stack: Stack = "none";
  if (dependencies.has("expo")) stack = "expo";
  else if (dependencies.has("react-native")) stack = "react-native";
  else if (await fs.exists(path.join(dir, "pubspec.yaml"))) stack = "flutter";
  else if (androidRoot) stack = "android";
  else if (iosRoot) stack = "ios";

  if (stack === "flutter") {
    const pubspec = (await text("pubspec.yaml")) ?? "";
    const pubLock = (await text("pubspec.lock")) ?? "";
    const sdks = /^sdks:\s*\n((?:[ \t]+.*\n?)*)/mu.exec(pubLock)?.[1] ?? "";
    const flutter =
      yamlValue(sdks, "flutter") ??
      yamlValue(/^environment:\s*\n((?:[ \t]+.*\n?)*)/mu.exec(pubspec)?.[1] ?? "", "flutter");
    const dart =
      yamlValue(sdks, "dart") ?? yamlValue(/^environment:\s*\n((?:[ \t]+.*\n?)*)/mu.exec(pubspec)?.[1] ?? "", "sdk");
    if (flutter) versions.flutter = flutter;
    if (dart) versions.dart = dart;
  }

  const devClient = dependencies.has("expo-dev-client");
  const nativeFolders = androidRoot !== undefined || iosRoot !== undefined;
  const client: ProjectRead["client"] =
    stack === "expo"
      ? devClient
        ? { kind: "dev-build", reason: "expo-dev-client is in package.json." }
        : nativeFolders
          ? {
              kind: "bare",
              reason: "It has its own native folders and no expo-dev-client, so it runs as a native debug build.",
            }
          : { kind: "expo-go", reason: "There is no expo-dev-client in package.json, so the app runs in Expo Go." }
      : stack === "none"
        ? { kind: "unknown", reason: "No mobile app was found." }
        : {
            kind: "bare",
            reason: stack === "react-native" ? "A React Native app with its own native projects." : "A native project.",
          };

  const newArch = newArchState({
    stack,
    expoMajor: major(versions.expo),
    rn: versions["react-native"],
    appJson: expo,
    gradleProps,
    podsProperties,
    androidFile: androidRoot ? rel(join(androidRoot, "gradle.properties")) : undefined,
    iosFile: iosRoot ? rel(join(iosRoot, "Podfile.properties.json")) : undefined,
    appJsonFile: rel("app.json"),
  });

  const expoAndroid = isObject(expo?.android) ? expo.android : undefined;
  const expoIos = isObject(expo?.ios) ? expo.ios : undefined;
  const androidId =
    stringOf(expoAndroid?.package) ??
    /applicationId\s*=?\s*["']([\w.]+)["']/u.exec(androidAppGradle ?? "")?.[1] ??
    /namespace\s*=?\s*["']([\w.]+)["']/u.exec(androidAppGradle ?? "")?.[1];
  const iosId = stringOf(expoIos?.bundleIdentifier) ?? iosBundle;
  const scheme = Array.isArray(expo?.scheme) ? stringOf(expo.scheme[0]) : stringOf(expo?.scheme);

  const signingConfigs = androidAppGradle ? braceBlock(androidAppGradle, "signingConfigs") : undefined;
  const androidSigning: ProjectRead["androidSigning"] =
    signingConfigs && /\brelease\s*\{|create\(\s*["']release["']\s*\)/u.test(signingConfigs)
      ? "release-config"
      : easJson !== undefined
        ? "eas"
        : androidAppGradle
          ? "debug-only"
          : "unknown";

  return {
    appDir,
    stack,
    versions,
    dependencies,
    devClient,
    packageManager: lock?.manager ?? (manifest ? declaredManager(manifest) : undefined),
    client,
    newArch,
    appIds: {
      ...(androidId ? { android: androidId } : {}),
      ...(iosId ? { ios: iosId } : {}),
      ...(scheme ? { scheme } : {}),
    },
    android,
    ios,
    androidSigning,
    hasPackageJson: manifest !== undefined,
    unreadable,
  };
}

function newArchState(input: {
  stack: Stack;
  expoMajor: number | undefined;
  rn: string | undefined;
  appJson: Json | undefined;
  gradleProps: Record<string, string>;
  podsProperties: Json | undefined;
  androidFile: string | undefined;
  iosFile: string | undefined;
  appJsonFile: string;
}): ProjectRead["newArch"] {
  if (input.stack !== "expo" && input.stack !== "react-native") return {};
  const disabledIn: string[] = [];
  const enabledIn: string[] = [];
  const note = (value: unknown, file: string | undefined) => {
    if (!file) return;
    if (value === false || value === "false") disabledIn.push(file);
    if (value === true || value === "true") enabledIn.push(file);
  };
  note(input.appJson?.newArchEnabled, input.appJsonFile);
  for (const platform of ["android", "ios"]) {
    const nested = input.appJson?.[platform];
    if (isObject(nested)) note(nested.newArchEnabled, input.appJsonFile);
  }
  note(input.gradleProps.newArchEnabled, input.androidFile);
  note(input.podsProperties?.newArchEnabled, input.iosFile);
  const uniqueDisabled = [...new Set(disabledIn)];
  const rnMinor = minorOf(input.rn);
  const forced = (input.expoMajor !== undefined && input.expoMajor >= 55) || (rnMinor !== undefined && rnMinor >= 82);
  if (forced)
    return {
      enabled: true,
      source: "Always on from Expo SDK 55 and React Native 0.82.",
      ...(uniqueDisabled.length > 0 ? { disabledIn: uniqueDisabled } : {}),
    };
  if (uniqueDisabled.length > 0)
    return { enabled: false, source: uniqueDisabled[0] as string, disabledIn: uniqueDisabled };
  if (enabledIn.length > 0) return { enabled: true, source: enabledIn[0] as string };
  const onByDefault =
    (input.expoMajor !== undefined && input.expoMajor >= 53) || (rnMinor !== undefined && rnMinor >= 76);
  return onByDefault ? { enabled: true, source: "On by default in this version." } : {};
}

type Lockfile = { manager: MobilePackageManager; text: string };

/** The nearest lockfile, in the app folder first and then up to the worktree root, as monorepos keep one there. */
async function findLockfile(
  fs: MobileFileSystem,
  root: string,
  dir: string,
  os: HostOs,
): Promise<Lockfile | undefined> {
  const path = pathFor(os);
  const files: [string, MobilePackageManager][] = [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lock", "bun"],
    ["package-lock.json", "npm"],
  ];
  let current = dir;
  for (;;) {
    for (const [file, manager] of files) {
      const text = await readText(fs, path.join(current, file));
      if (text !== undefined) return { manager, text };
    }
    if (current === root || path.relative(root, current).startsWith("..")) return undefined;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** The version a lockfile resolved for a package, found with patterns rather than a full parse. */
export function lockedVersion(manager: MobilePackageManager, text: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&");
  switch (manager) {
    case "npm": {
      const parsed = parseJson(text);
      const packages = isObject(parsed?.packages) ? parsed.packages : undefined;
      if (packages) {
        for (const [key, value] of Object.entries(packages)) {
          if ((key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`)) && isObject(value))
            return stringOf(value.version);
        }
      }
      const dependencies = isObject(parsed?.dependencies) ? parsed.dependencies : undefined;
      const entry = dependencies?.[name];
      return isObject(entry) ? stringOf(entry.version) : undefined;
    }
    case "pnpm":
      return new RegExp(`^\\s+['"]?/?${escaped}[@/](\\d+\\.\\d+\\.\\d+[^:('"\\s]*)`, "mu").exec(text)?.[1];
    case "yarn":
      return new RegExp(`^"?${escaped}@[^\\n]*:\\r?\\n\\s+version:? "?([^"\\r\\n]+)"?`, "mu").exec(text)?.[1];
    case "bun":
      return new RegExp(`"${escaped}@(\\d[^"]*)"`, "u").exec(text)?.[1];
  }
}

async function installedVersion(
  fs: MobileFileSystem,
  dirs: readonly string[],
  name: string,
  os: HostOs,
): Promise<string | undefined> {
  const path = pathFor(os);
  for (const dir of dirs) {
    const manifest = await readJson(fs, path.join(dir, "node_modules", ...name.split("/"), "package.json"));
    const version = stringOf(manifest?.version);
    if (version) return version;
  }
  return undefined;
}

function declaredVersion(manifest: Json | undefined, name: string): string | undefined {
  for (const field of ["dependencies", "devDependencies"]) {
    const group = manifest?.[field];
    const spec = isObject(group) ? stringOf(group[name]) : undefined;
    const version = spec ? /\d+(?:\.\d+){0,2}(?:-[\w.]+)?/u.exec(spec)?.[0] : undefined;
    if (version) return version;
  }
  return undefined;
}

function declaredManager(manifest: Json): MobilePackageManager | undefined {
  const field = stringOf(manifest.packageManager);
  const name = field?.split("@")[0];
  return name === "pnpm" || name === "yarn" || name === "bun" || name === "npm" ? name : undefined;
}

function dependencyNames(manifest: Json): string[] {
  return ["dependencies", "devDependencies"].flatMap((field) => {
    const group = manifest[field];
    return isObject(group) ? Object.keys(group) : [];
  });
}

function agpVersion(text: string): string | undefined {
  return (
    /com\.android\.tools\.build:gradle:(\d+(?:\.\d+)+[\w.-]*)/u.exec(text)?.[1] ??
    /id\s*\(?\s*["']com\.android\.(?:application|library)["']\s*\)?\s+version\s+["'](\d+(?:\.\d+)+[\w.-]*)["']/u.exec(
      text,
    )?.[1] ??
    /^\s*(?:agp|androidGradlePlugin|android-gradle-plugin|androidGradle)\s*=\s*["'](\d+(?:\.\d+)+[\w.-]*)["']/mu.exec(
      text,
    )?.[1]
  );
}

function kotlinVersion(text: string): string | undefined {
  return (
    /kotlin(?:_version|Version)\s*=\s*["'](\d+(?:\.\d+)+[\w.-]*)["']/u.exec(text)?.[1] ??
    /org\.jetbrains\.kotlin:kotlin-gradle-plugin:(\d+(?:\.\d+)+[\w.-]*)/u.exec(text)?.[1] ??
    /id\s*\(?\s*["']org\.jetbrains\.kotlin\.android["']\s*\)?\s+version\s+["'](\d+(?:\.\d+)+[\w.-]*)["']/u.exec(
      text,
    )?.[1] ??
    /^\s*kotlin\s*=\s*["'](\d+(?:\.\d+)+[\w.-]*)["']/mu.exec(text)?.[1]
  );
}

async function xcodeProject(fs: MobileFileSystem, dir: string, os: HostOs): Promise<string | undefined> {
  const path = pathFor(os);
  const project = (await fs.readdir(dir)).filter((entry) => entry.endsWith(".xcodeproj")).sort()[0];
  return project ? readText(fs, path.join(dir, project, "project.pbxproj")) : undefined;
}

export function parseProperties(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/u)) {
    const match = /^\s*([^#!\s=:][^=:\s]*)\s*[=:]\s*(.*?)\s*$/u.exec(line);
    if (match?.[1]) values[match[1]] = match[2] ?? "";
  }
  return values;
}

/** The text inside the braces after name, such as the body of signingConfigs { ... }, matching nested braces. */
function braceBlock(text: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*\\{`, "u").exec(text);
  if (!match) return undefined;
  let depth = 1;
  const start = match.index + match[0].length;
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index);
    }
  }
  return text.slice(start);
}

function yamlValue(block: string, key: string): string | undefined {
  const value = new RegExp(`^\\s+${key}:\\s*(.+?)\\s*$`, "mu").exec(block)?.[1];
  return value?.replace(/^["']|["']$/gu, "").slice(0, 60);
}

function join(base: string, relative: string): string {
  return base === "." ? relative : `${base}/${relative}`;
}

function normalize(text: string): string {
  return text.replaceAll("\r\n", "\n").trim();
}

export function major(version: string | undefined): number | undefined {
  const value = version ? Number.parseInt(version, 10) : Number.NaN;
  return Number.isFinite(value) ? value : undefined;
}

/** The minor of a 0.x version, such as 85 for react-native 0.85.1. */
export function minorOf(version: string | undefined): number | undefined {
  const match = version ? /^0\.(\d+)/u.exec(version) : null;
  return match?.[1] ? Number.parseInt(match[1], 10) : undefined;
}

export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

async function readText(fs: MobileFileSystem, path: string): Promise<string | undefined> {
  try {
    return await fs.readFile(path);
  } catch {
    return undefined;
  }
}

async function readJson(fs: MobileFileSystem, path: string): Promise<Json | undefined> {
  const text = await readText(fs, path);
  return text === undefined ? undefined : parseJson(text);
}

function parseJson(text: string): Json | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 200 ? value : undefined;
}
