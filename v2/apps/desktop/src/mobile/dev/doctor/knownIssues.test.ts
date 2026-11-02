import { describe, expect, it } from "vitest";

import { findIssues, type IssueFacts } from "./knownIssues.js";

const expo = (overrides: Partial<IssueFacts> = {}): IssueFacts => ({
  appDir: ".",
  stack: "expo",
  versions: { expo: "56.0.3", "react-native": "0.85.1" },
  devClient: true,
  newArch: { enabled: true, source: "Always on from Expo SDK 55 and React Native 0.82." },
  host: { java: "17.0.12" },
  ...overrides,
});

const ids = (facts: IssueFacts) => findIssues(facts).map((finding) => finding.id);

describe("known issues", () => {
  it("finds nothing but the install note in a current Expo app", () => {
    expect(ids(expo())).toEqual(["npm-install-in-expo"]);
  });

  it("flags React Native that does not match the Expo SDK, with an expo install --fix proposal", () => {
    const [finding] = findIssues(
      expo({ versions: { expo: "56.0.3", "react-native": "0.84.2" }, appDir: "apps/mobile" }),
    );
    expect(finding).toMatchObject({
      id: "expo-sdk-rn-mismatch",
      severity: "warning",
      title: "React Native 0.84.2 does not match Expo SDK 56",
      fix: {
        kind: "command",
        program: "npx",
        args: ["expo", "install", "--fix"],
        cwd: "apps/mobile",
        env: { CI: "1" },
      },
      source: "https://expo.dev/changelog/sdk-56",
    });
    expect(ids(expo({ versions: { expo: "57.0.0", "react-native": "0.86.0" } }))).not.toContain("expo-sdk-rn-mismatch");
  });

  it("calls newArchEnabled=false an error from SDK 55 and React Native 0.82 on", () => {
    const off = { enabled: true, disabledIn: ["app.json"] };
    const findings = findIssues(expo({ versions: { expo: "55.0.4", "react-native": "0.83.1" }, newArch: off }));
    expect(findings[0]).toMatchObject({ id: "newarch-optout-removed", severity: "error" });
    expect(findings[0]?.detail).toContain(
      "SDK 55 and later cannot turn off the New Architecture, so this build fails.",
    );
    expect(ids({ appDir: ".", stack: "react-native", versions: { "react-native": "0.82.0" }, newArch: off })).toContain(
      "newarch-optout-removed",
    );
    expect(
      ids(
        expo({
          versions: { expo: "54.0.0", "react-native": "0.81.4" },
          newArch: { enabled: false, disabledIn: ["app.json"] },
        }),
      ),
    ).not.toContain("newarch-optout-removed");
  });

  it("warns about Expo Go from SDK 55 without expo-dev-client, but not for a bare app", () => {
    const expoGo = { kind: "expo-go", reason: "There is no expo-dev-client in package.json." } as const;
    expect(ids(expo({ devClient: false, client: expoGo }))).toContain("expo-go-sdk55");
    expect(
      ids(expo({ devClient: false, client: { kind: "bare", reason: "It has its own native folders." } })),
    ).not.toContain("expo-go-sdk55");
    expect(
      ids(expo({ devClient: false, client: expoGo, versions: { expo: "54.0.0", "react-native": "0.81.0" } })),
    ).not.toContain("expo-go-sdk55");
  });

  it("calls Java older than 17 an error for React Native 0.73 and later, and skips a missing Java", () => {
    expect(ids(expo({ host: { java: "1.8.0_391" } }))[0]).toBe("jdk-too-old");
    expect(
      ids(expo({ host: { java: "11.0.2" }, versions: { "react-native": "0.72.0" }, stack: "react-native" })),
    ).toEqual([]);
    expect(ids(expo({ host: { java: "not found" } }))).not.toContain("jdk-too-old");
  });

  it("warns about AGP 9 opt-out flags, but not on AGP 8", () => {
    const native = (agp: string | undefined): IssueFacts => ({
      appDir: ".",
      stack: "android",
      versions: {},
      android: { ...(agp ? { agp } : {}), builtInKotlinOptOut: true },
    });
    expect(findIssues(native("9.0.1"))[0]?.detail).toContain(
      "Google says these opt-out flags stop working in summer 2026",
    );
    expect(ids(native(undefined))).toEqual(["agp9-optout-flags"]);
    expect(ids(native("8.10.1"))).toEqual([]);
  });

  it("proposes pod install in the right folder when pods drifted, and notes the CocoaPods trunk date", () => {
    const findings = findIssues({
      appDir: "apps/mobile",
      stack: "react-native",
      versions: {},
      ios: { podfile: true, podsDrift: true },
    });
    expect(findings.map((finding) => finding.id)).toEqual(["pods-drift", "cocoapods-trunk"]);
    expect(findings[0]?.fix).toMatchObject({ program: "pod", args: ["install"], cwd: "apps/mobile/ios" });
    expect(findings[1]?.title).toBe("CocoaPods trunk becomes read-only on December 2, 2026");
    expect(ids({ appDir: ".", stack: "ios", versions: {}, ios: { podfile: true, podsDrift: false } })).toEqual([
      "cocoapods-trunk",
    ]);
  });

  it("turns expo install --check results into a warning with a fix", () => {
    const deep = {
      ranAt: "2026-01-02T03:04:05.000Z",
      expoInstallCheck: { ok: false, state: "failed" as const, packages: ["react-native-reanimated"] },
    };
    expect(findIssues(expo({ deep }))[0]).toMatchObject({
      id: "expo-install-check",
      title: "1 package does not match this Expo SDK",
    });
  });

  it("puts errors first and cites a source for every rule", () => {
    const findings = findIssues(
      expo({
        devClient: false,
        client: { kind: "expo-go", reason: "There is no expo-dev-client in package.json." },
        versions: { expo: "55.0.0", "react-native": "0.80.0" },
        newArch: { enabled: true, disabledIn: ["app.json"] },
        ios: { podfile: true },
        unreadable: ["eas.json"],
      }),
    );
    expect(findings.map((finding) => finding.severity)).toEqual([
      "error",
      "warning",
      "warning",
      "info",
      "info",
      "info",
    ]);
    for (const finding of findings.filter((entry) => !entry.id.startsWith("unreadable")))
      expect(finding.source).toMatch(/^https:\/\//u);
    expect(findings.at(-1)).toMatchObject({ id: "unreadable:eas.json", title: "ZLI could not read eas.json" });
  });
});
