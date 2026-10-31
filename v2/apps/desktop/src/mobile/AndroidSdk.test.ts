import { describe, expect, it } from "vitest";

import {
  androidStatus,
  avdHome,
  detectAndroidSdk,
  detectJava,
  listAvds,
  listSystemImages,
  parseAccelCheck,
  parseJavaVersion,
} from "./AndroidSdk.js";
import { FakeProcessRunner } from "./FakeProcessRunner.js";
import type { MobileFileSystem } from "./host.js";

/** An in-memory file tree. Directories exist when any file lives under them. */
function memoryFs(files: Record<string, string>, separator = "/"): MobileFileSystem {
  const paths = Object.keys(files);
  const isDirectory = async (path: string) => paths.some((file) => file.startsWith(`${path}${separator}`));
  return {
    exists: async (path) => path in files || (await isDirectory(path)),
    isDirectory,
    readdir: async (path) => [
      ...new Set(
        paths
          .filter((file) => file.startsWith(`${path}${separator}`))
          .map((file) => file.slice(path.length + 1).split(separator)[0] as string),
      ),
    ],
    readFile: async (path) => {
      const content = files[path];
      if (content === undefined) throw new Error(`ENOENT ${path}`);
      return content;
    },
  };
}

const HOME = "/home/dev";
const ZLI = "/home/dev/.config/ZLI/mobile/android-sdk";

describe("Android SDK detection", () => {
  it("prefers ANDROID_HOME over the default location", async () => {
    const fs = memoryFs({
      "/opt/sdk/platform-tools/adb": "",
      "/opt/sdk/emulator/emulator": "",
      "/opt/sdk/cmdline-tools/latest/bin/sdkmanager": "",
      "/opt/sdk/cmdline-tools/latest/bin/avdmanager": "",
      "/home/dev/Android/Sdk/platform-tools/adb": "",
    });
    const layout = await detectAndroidSdk({
      os: "linux",
      env: { ANDROID_HOME: "/opt/sdk" },
      home: HOME,
      zliSdkRoot: ZLI,
      fs,
    });
    expect(layout).toEqual({
      root: "/opt/sdk",
      source: "env",
      adb: "/opt/sdk/platform-tools/adb",
      emulator: "/opt/sdk/emulator/emulator",
      sdkmanager: "/opt/sdk/cmdline-tools/latest/bin/sdkmanager",
      avdmanager: "/opt/sdk/cmdline-tools/latest/bin/avdmanager",
    });
  });

  it("finds the default install, versioned cmdline-tools, and adb on PATH", async () => {
    const fs = memoryFs({
      "/home/dev/Android/Sdk/cmdline-tools/9.0/bin/sdkmanager": "",
      "/home/dev/Android/Sdk/cmdline-tools/11.0/bin/sdkmanager": "",
      "/usr/bin/adb": "",
    });
    const layout = await detectAndroidSdk({
      os: "linux",
      env: { PATH: "/usr/local/bin:/usr/bin" },
      home: HOME,
      zliSdkRoot: ZLI,
      fs,
    });
    expect(layout.source).toBe("default");
    expect(layout.sdkmanager).toBe("/home/dev/Android/Sdk/cmdline-tools/11.0/bin/sdkmanager");
    expect(layout.adb).toBe("/usr/bin/adb");
    expect(layout.emulator).toBeUndefined();
  });

  it("uses Windows file names and LOCALAPPDATA", async () => {
    const root = "C:\\Users\\dev\\AppData\\Local\\Android\\Sdk";
    const fs = memoryFs(
      {
        [`${root}\\platform-tools\\adb.exe`]: "",
        [`${root}\\emulator\\emulator.exe`]: "",
        [`${root}\\cmdline-tools\\latest\\bin\\sdkmanager.bat`]: "",
      },
      "\\",
    );
    const layout = await detectAndroidSdk({
      os: "windows",
      env: { LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local" },
      home: "C:\\Users\\dev",
      zliSdkRoot: "C:\\Users\\dev\\AppData\\Roaming\\ZLI\\mobile\\android-sdk",
      fs,
    });
    expect(layout.source).toBe("default");
    expect(layout.adb).toBe(`${root}\\platform-tools\\adb.exe`);
    expect(layout.sdkmanager).toBe(`${root}\\cmdline-tools\\latest\\bin\\sdkmanager.bat`);
  });

  it("falls back to ZLI's own SDK folder when there is none", async () => {
    const layout = await detectAndroidSdk({
      os: "macos",
      env: {},
      home: "/Users/dev",
      zliSdkRoot: ZLI,
      fs: memoryFs({}),
    });
    expect(layout).toEqual({ root: ZLI, source: "none" });
  });

  it("lists installed system images and AVDs", async () => {
    const fs = memoryFs({
      "/sdk/system-images/android-35/google_apis/x86_64/system.img": "",
      "/sdk/system-images/android-34/google_apis/x86_64/readme.txt": "",
      "/home/dev/.android/avd/Pixel_7.ini": "avd.ini.encoding=UTF-8\npath=/home/dev/.android/avd/Pixel_7.avd\n",
      "/home/dev/.android/avd/Pixel_7.avd/config.ini":
        "avd.ini.displayname=Pixel 7 API 35\nimage.sysdir.1=system-images/android-35/google_apis/x86_64/\n",
      "/home/dev/.android/avd/Broken.ini": "path=/missing\n",
    });
    expect(await listSystemImages("/sdk", "linux", fs)).toEqual(["system-images;android-35;google_apis;x86_64"]);
    expect(await listAvds(avdHome("linux", HOME, {}), "linux", fs)).toEqual([
      { name: "Broken", displayName: "Broken" },
      { name: "Pixel_7", displayName: "Pixel 7 API 35", systemImage: "system-images;android-35;google_apis;x86_64" },
    ]);
    expect(avdHome("linux", HOME, { ANDROID_USER_HOME: "/x" })).toBe("/x/avd");
    expect(avdHome("linux", HOME, { ANDROID_AVD_HOME: "/y" })).toBe("/y");
  });
});

describe("Java detection", () => {
  it("reads old and new version strings", () => {
    expect(parseJavaVersion('openjdk version "17.0.12" 2024-07-16')).toEqual({ version: "17.0.12", major: 17 });
    expect(parseJavaVersion('java version "1.8.0_401"')).toEqual({ version: "1.8.0_401", major: 8 });
    expect(parseJavaVersion('openjdk version "21" 2023-09-19')).toEqual({ version: "21", major: 21 });
    expect(parseJavaVersion("nothing")).toBeUndefined();
  });

  it("skips a Java that is too old and picks ZLI's own runtime", async () => {
    const fs = memoryFs({
      "/jdk8/bin/java": "",
      "/zli/jre/jdk-17.0.17+10-jre/bin/java": "",
    });
    const runner = new FakeProcessRunner((command) =>
      command === "/jdk8/bin/java"
        ? { stderr: 'java version "1.8.0_401"' }
        : { stderr: 'openjdk version "17.0.17" 2025-10-21' },
    );
    const java = await detectJava({ os: "linux", env: { JAVA_HOME: "/jdk8" }, zliJreRoot: "/zli/jre", fs, runner });
    expect(java).toEqual({ path: "/zli/jre/jdk-17.0.17+10-jre/bin/java", version: "17.0.17", major: 17 });
  });
});

describe("Android status", () => {
  it("summarizes the accel check output", () => {
    expect(parseAccelCheck("accel:\n0\nKVM (version 12) is installed and usable.\naccel\n")).toBe(
      "KVM (version 12) is installed and usable.",
    );
  });

  it("lists what is missing in plain words", () => {
    const status = androidStatus({
      layout: { root: ZLI, source: "none" },
      java: { path: "/usr/bin/java", version: "11.0.2", major: 11 },
      systemImages: [],
      avds: [],
      acceleration: { checked: true, usable: false, detail: "/dev/kvm is not found." },
    });
    expect(status.missing).toEqual([
      "Android platform tools (adb)",
      "Android Emulator",
      "An Android system image",
      "A virtual device (AVD)",
      "Android SDK command-line tools",
      "Java 17 or newer, which the SDK tools run on",
      "Hardware acceleration for the emulator",
    ]);
    expect(status.sdkRoot).toBeUndefined();
    expect(status.java).toEqual({ found: false, path: "/usr/bin/java", version: "11.0.2" });
  });
});
