import { describe, expect, it } from "vitest";

import { createTestDevHost } from "../testHost.js";
import { lockedVersion, readProject } from "./readProject.js";
import { fixtureFiles } from "./testFixtures.js";

async function read(name: string, extra: Record<string, string> = {}) {
  const host = createTestDevHost({ files: { ...fixtureFiles(name), ...extra } });
  return readProject(host.fs, "/repo/app", "linux");
}

describe("readProject", () => {
  it("reads an Expo 56 app with a development build", async () => {
    const project = await read("expo56-devclient");
    expect(project).toMatchObject({
      appDir: ".",
      stack: "expo",
      versions: { expo: "56.0.3", "react-native": "0.85.1", react: "19.2.0" },
      devClient: true,
      packageManager: "npm",
      client: { kind: "dev-build" },
      newArch: { enabled: true },
      appIds: { android: "com.example.devclient", ios: "com.example.devclient", scheme: "devclient" },
      androidSigning: "eas",
      unreadable: [],
    });
    expect(project?.android).toBeUndefined();
    expect(project?.ios).toBeUndefined();
  });

  it("finds every place an Expo 55 app turns off the New Architecture", async () => {
    const project = await read("expo55-newarch-off");
    expect(project).toMatchObject({
      stack: "expo",
      versions: { expo: "55.0.4", "react-native": "0.83.1" },
      packageManager: "yarn",
      devClient: false,
      newArch: { enabled: true, disabledIn: ["app.json", "android/gradle.properties"] },
    });
  });

  it("reads a bare React Native app's Gradle, signing, and Xcode settings", async () => {
    const project = await read("rn-bare-0.85");
    expect(project).toMatchObject({
      stack: "react-native",
      packageManager: "pnpm",
      versions: { "react-native": "0.85.1", react: "19.2.0", gradle: "8.14.3", agp: "8.10.1", kotlin: "2.1.20" },
      client: { kind: "bare" },
      appIds: { android: "com.example.rnbare", ios: "com.example.rnbare" },
      androidSigning: "debug-only",
      ios: { podfile: true, podsDrift: false, deploymentTarget: "15.1", developmentTeam: true },
    });
  });

  it("reads a Flutter app and its Kotlin DSL Gradle files", async () => {
    const project = await read("flutter");
    expect(project).toMatchObject({
      stack: "flutter",
      versions: { flutter: ">=3.24.0", dart: ">=3.5.0 <4.0.0", gradle: "9.1.0", agp: "9.0.0", kotlin: "2.2.20" },
      android: { builtInKotlinOptOut: true, newDslOptOut: true },
      androidSigning: "debug-only",
      appIds: { android: "com.example.flutter_app" },
    });
  });

  it("reads a native Android app at the worktree root with a version catalog", async () => {
    const project = await read("native-android-agp9-optout");
    expect(project).toMatchObject({
      appDir: ".",
      stack: "android",
      versions: { agp: "9.0.1", kotlin: "2.2.20", gradle: "9.1.0" },
      android: { builtInKotlinOptOut: true, newDslOptOut: true },
      androidSigning: "release-config",
      appIds: { android: "com.example.nativeapp" },
    });
  });

  it("sees installed pods that drifted from Podfile.lock in a native iOS app", async () => {
    const project = await read("ios-pods-drift");
    expect(project).toMatchObject({
      stack: "ios",
      ios: { podfile: true, podsDrift: true, deploymentTarget: "16.0", developmentTeam: false },
      appIds: { ios: "com.example.drift" },
    });
  });

  it("finds the app in apps/mobile and the lockfile at the monorepo root", async () => {
    const project = await read("monorepo-apps-mobile");
    expect(project).toMatchObject({
      appDir: "apps/mobile",
      stack: "expo",
      packageManager: "pnpm",
      versions: { expo: "56.0.5", "react-native": "0.84.2" },
      appIds: { scheme: "mobile" },
    });
  });

  it("reports a malformed file as unreadable and its facts as unknown", async () => {
    const project = await read("expo56-devclient", { "/repo/app/app.json": "{ nope" });
    expect(project?.stack).toBe("expo");
    expect(project?.unreadable).toEqual(["app.json"]);
    expect(project?.appIds).toEqual({});
  });

  it("finds no app in a folder without one", async () => {
    const host = createTestDevHost({ files: { "/repo/app/README.md": "# Hi", "/repo/app/docs/a.md": "a" } });
    expect(await readProject(host.fs, "/repo/app", "linux")).toBeUndefined();
  });

  it("reads versions from each lockfile format", () => {
    expect(lockedVersion("yarn", '"expo@npm:~56.0.0":\n  version: 56.0.3\n', "expo")).toBe("56.0.3");
    expect(lockedVersion("pnpm", "packages:\n  /expo/52.0.1:\n    resolution: {}\n", "expo")).toBe("52.0.1");
    expect(lockedVersion("bun", '{ "packages": { "expo": ["expo@56.0.2", "", {}] } }', "expo")).toBe("56.0.2");
    expect(lockedVersion("npm", '{ "dependencies": { "expo": { "version": "49.0.1" } } }', "expo")).toBe("49.0.1");
    expect(lockedVersion("pnpm", "packages:\n  expo-router@6.0.0:\n", "expo")).toBeUndefined();
  });
});
