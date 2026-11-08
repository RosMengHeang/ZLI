import type { MobileProjectFacts } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import { installAction, UNCHECKED_REASON, verdictFor } from "./rules.js";

function facts(overrides: Partial<MobileProjectFacts> = {}): MobileProjectFacts {
  return {
    worktreeId: "wt-1",
    appDir: "apps/mobile",
    stack: "expo",
    versions: { expo: "56.0.3" },
    findings: [],
    fingerprint: "abc",
    checkedAt: "2026-01-02T03:04:05.000Z",
    ...overrides,
  };
}

const on = { enabled: true } as const;
const off = { enabled: false } as const;

describe("package guard rules", () => {
  it("marks a package not checked when the directory could not be reached", () => {
    expect(verdictFor("react-native-fs", undefined, facts())).toEqual({
      name: "react-native-fs",
      verdict: "unchecked",
      reasons: [UNCHECKED_REASON],
    });
  });

  it("warns about a package the directory does not list", () => {
    expect(verdictFor("left-pad", { found: false }, facts())).toMatchObject({ verdict: "warn" });
  });

  it("passes a supported package and keeps what the directory says", () => {
    expect(
      verdictFor(
        "react-native-reanimated",
        { found: true, newArchitecture: "supported", expoGo: true, configPlugin: false, latest: "4.2.1" },
        facts({ newArch: on }),
      ),
    ).toEqual({
      name: "react-native-reanimated",
      verdict: "ok",
      reasons: ["Supports the New Architecture."],
      newArchitecture: "supported",
      expoGo: true,
      configPlugin: false,
      latest: "4.2.1",
    });
  });

  it("blocks untested or unsupported packages only when the project uses the New Architecture", () => {
    for (const arch of ["untested", "unsupported"] as const) {
      const entry = { found: true, newArchitecture: arch };
      expect(verdictFor("x", entry, facts({ newArch: on })).verdict).toBe("block");
      expect(verdictFor("x", entry, facts()).verdict).toBe("warn");
      expect(verdictFor("x", entry, facts({ newArch: off })).verdict).toBe("ok");
    }
  });

  it("blocks a New Architecture only package when the project turned it off", () => {
    const entry = { found: true, newArchitecture: "new-arch-only" } as const;
    expect(verdictFor("react-native-vision-camera", entry, facts({ newArch: off }))).toMatchObject({
      verdict: "block",
      reasons: ["It needs the New Architecture, which this project has turned off."],
    });
    expect(verdictFor("react-native-vision-camera", entry, facts({ newArch: on })).verdict).toBe("ok");
  });

  it("warns about unmaintained or archived packages and Expo Go gaps, and mentions config plugins", () => {
    const verdict = verdictFor(
      "react-native-fs",
      {
        found: true,
        newArchitecture: "untested",
        unmaintained: true,
        archived: true,
        expoGo: false,
        configPlugin: true,
      },
      facts({ newArch: off, client: { kind: "expo-go", reason: "No expo-dev-client." } }),
    );
    expect(verdict.verdict).toBe("warn");
    expect(verdict.reasons).toEqual([
      "React Native Directory marks it unmaintained. Look for a maintained alternative.",
      "Its GitHub repository is archived.",
      "It does not run in Expo Go, so the app needs a development build.",
      "It has a config plugin. Add it to plugins in app.json and rebuild.",
    ]);
  });

  it("installs with npx expo install in Expo apps and the lockfile's package manager otherwise", () => {
    expect(installAction(["expo-camera"], facts())).toEqual({
      kind: "command",
      program: "npx",
      args: ["expo", "install", "expo-camera"],
      cwd: "apps/mobile",
    });
    const bare = (packageManager?: MobileProjectFacts["packageManager"]) =>
      installAction(
        ["react-native-mmkv"],
        facts({ stack: "react-native", appDir: ".", ...(packageManager ? { packageManager } : {}) }),
      );
    expect(bare("pnpm")).toMatchObject({ program: "pnpm", args: ["add", "react-native-mmkv"], cwd: "." });
    expect(bare("yarn")).toMatchObject({ program: "yarn", args: ["add", "react-native-mmkv"] });
    expect(bare("bun")).toMatchObject({ program: "bun", args: ["add", "react-native-mmkv"] });
    expect(bare()).toMatchObject({ program: "npm", args: ["install", "react-native-mmkv"] });
  });

  it("has no install command without packages or an npm based app", () => {
    expect(installAction([], facts())).toBeUndefined();
    expect(installAction(["x"], undefined)).toBeUndefined();
    expect(installAction(["x"], facts({ stack: "flutter" }))).toBeUndefined();
  });
});
