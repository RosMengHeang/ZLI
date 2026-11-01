import { describe, expect, it } from "vitest";

import { createTestDevHost } from "../testHost.js";
import { readProjectInfo } from "./projectInfo.js";

const read = (files: Record<string, string>, os: "linux" | "windows" = "linux", root = "/repo/app") => {
  const host = createTestDevHost({ files, os });
  return readProjectInfo(root, host.fs, os);
};

describe("project info", () => {
  it("finds a development build and its scheme at the root", async () => {
    expect(
      await read({
        "/repo/app/package.json": JSON.stringify({
          dependencies: { expo: "54.0.0" },
          devDependencies: { "expo-dev-client": "6.0.0" },
        }),
        "/repo/app/app.json": JSON.stringify({ expo: { scheme: "myapp" } }),
      }),
    ).toEqual({ devClient: true, scheme: "myapp", appDir: "." });
  });

  it("treats an Expo app without expo-dev-client as Expo Go, and reads a static app.config.json", async () => {
    expect(
      await read({
        "/repo/app/package.json": JSON.stringify({ dependencies: { expo: "54.0.0" } }),
        "/repo/app/app.config.json": JSON.stringify({ scheme: ["shop", "shop-dev"] }),
        "/repo/app/app.config.js": "module.exports = { scheme: 'never-read' };",
      }),
    ).toEqual({ devClient: false, scheme: "shop", appDir: "." });
  });

  it("finds the app one folder down in a monorepo, skipping node_modules", async () => {
    expect(
      await read({
        "/repo/app/package.json": JSON.stringify({ private: true, workspaces: ["apps/*"] }),
        "/repo/app/apps/node_modules/expo/package.json": JSON.stringify({ dependencies: { "expo-dev-client": "1" } }),
        "/repo/app/apps/web/package.json": JSON.stringify({ dependencies: { next: "15" } }),
        "/repo/app/apps/mobile/package.json": JSON.stringify({
          dependencies: { "react-native": "0.81", "expo-dev-client": "6" },
        }),
        "/repo/app/apps/mobile/app.json": JSON.stringify({ expo: { scheme: "acme" } }),
      }),
    ).toEqual({ devClient: true, scheme: "acme", appDir: "apps/mobile" });
  });

  it("ignores broken JSON, unsafe schemes, and folders with no app", async () => {
    expect(await read({ "/repo/app/package.json": "{not json" })).toEqual({ devClient: false });
    expect(
      await read({
        "/repo/app/package.json": JSON.stringify({ dependencies: { expo: "54" } }),
        "/repo/app/app.json": JSON.stringify({ expo: { scheme: "bad scheme://" } }),
      }),
    ).toEqual({ devClient: false, appDir: "." });
  });

  it("uses Windows paths on Windows", async () => {
    expect(
      await read(
        {
          "C:\\repo\\app\\packages\\phone\\package.json": JSON.stringify({ dependencies: { expo: "54" } }),
          "C:\\repo\\app\\packages\\phone\\app.json": JSON.stringify({ expo: { scheme: "phone" } }),
        },
        "windows",
        "C:\\repo\\app",
      ),
    ).toEqual({ devClient: false, scheme: "phone", appDir: "packages/phone" });
  });
});
