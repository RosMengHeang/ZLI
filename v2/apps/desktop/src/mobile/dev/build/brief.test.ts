import { readFileSync } from "node:fs";

import { MobileBuildBrief, type MobileProjectFactsCore, MobileProposalAction } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import { fixtureFiles } from "../doctor/testFixtures.js";
import { createTestDevHost } from "../testHost.js";
import { buildBrief, composeBrief } from "./brief.js";
import { classifyBuildLog } from "./classify.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.log`, import.meta.url), "utf8");
const ALWAYS = "Do not add @ts-ignore, @Suppress, try!, or skip tests to make the build pass.";

const facts: MobileProjectFactsCore = {
  worktreeId: "wt-1",
  appDir: "apps/mobile",
  stack: "expo",
  versions: { expo: "56.0.3", "react-native": "0.85.1" },
  findings: [
    { id: "info", severity: "info", title: "Expo SDK 56", detail: "" },
    { id: "rn", severity: "error", title: "react-native-reanimated 3.1.0 is too old for SDK 56", detail: "" },
  ],
  fingerprint: "abc",
  checkedAt: "2026-01-02T03:04:05.000Z",
};

describe("build brief", () => {
  it("says the version checks did not run without the doctor's facts", async () => {
    const brief = await buildBrief(createTestDevHost(), "wt-gone", fixture("gradle-unsupported-class-version"));
    expect(MobileBuildBrief.parse(brief)).toBeTruthy();
    expect(brief.versionChecked).toBe(false);
    expect(brief.text).toContain("Version checks did not run.");
    expect(brief.text.split("\n")[0]).toBe("Build failure: JDK / Gradle (Gradle, high confidence).");
    expect(brief.suggestion).toEqual({ text: "Install JDK 17 and point JAVA_HOME to it." });
  });

  it("reads the doctor's real findings for the worktree's app", async () => {
    const host = createTestDevHost({ files: fixtureFiles("expo55-newarch-off") });
    const brief = await buildBrief(host, "wt-1", fixture("rn-codegen-turbomodule"));
    expect(MobileBuildBrief.parse(brief)).toBeTruthy();
    expect(brief.versionChecked).toBe(true);
    expect(brief.versionFindings.map((finding) => finding.id)).toContain("newarch-optout-removed");
  });

  it("leads with the doctor's findings, errors first, and puts files under the app folder", () => {
    const brief = composeBrief(classifyBuildLog(fixture("gradle-kotlin-metadata")), facts);
    expect(brief.versionFindings.map((finding) => finding.id)).toEqual(["rn", "info"]);
    const lines = brief.text.split("\n");
    expect(lines.indexOf("Version checks:")).toBeLessThan(lines.findIndex((line) => line.startsWith("First error")));
    expect(brief.text).toContain("- error: react-native-reanimated 3.1.0 is too old for SDK 56");
    expect(brief.likelyFiles[0]).toBe("apps/mobile/package.json");
    expect(brief.suggestion?.action).toEqual({
      kind: "command",
      program: "npx",
      args: ["expo", "install", "--fix"],
      cwd: "apps/mobile",
      env: { CI: "1" },
    });
    expect(brief.text).toContain("Propose: CI=1 npx expo install --fix (mobile_propose)");
  });

  it.each([
    ["gradle-kotlin-metadata", "Do not downgrade packages to make the error go away."],
    ["rn-codegen-turbomodule", "Do not set newArchEnabled=false."],
    [
      "xcode-no-signing",
      "Do not create or change certificates, profiles, or keystores; tell the person what is missing.",
    ],
    ["gradle-java-heap", undefined],
  ])("lists what to avoid for %s", (name, avoid) => {
    const brief = composeBrief(classifyBuildLog(fixture(name)), undefined);
    expect(brief.avoid).toEqual(avoid ? [avoid, ALWAYS] : [ALWAYS]);
    for (const line of brief.avoid) expect(brief.text).toContain(`- ${line}`);
  });

  it("only suggests commands a proposal can carry", () => {
    const names = [
      "gradle-kotlin-metadata",
      "gradle-unsupported-class-version",
      "gradle-duplicate-class",
      "gradle-java-heap",
      "eas-pods-incompatible",
      "eas-config-plugin",
      "xcode-no-signing",
      "xcode-provisioning",
      "rn-codegen-turbomodule",
      "metro-unable-to-resolve",
      "unknown-noise",
    ];
    for (const name of names) {
      for (const withFacts of [undefined, facts]) {
        const brief = composeBrief(classifyBuildLog(fixture(name)), withFacts);
        expect(MobileBuildBrief.safeParse(brief).success).toBe(true);
        if (brief.suggestion?.action)
          expect(MobileProposalAction.safeParse(brief.suggestion.action).success).toBe(true);
      }
    }
    const pods = composeBrief(classifyBuildLog(fixture("eas-pods-incompatible")), undefined);
    expect(pods.suggestion?.action).toEqual({
      kind: "command",
      program: "pod",
      args: ["install", "--repo-update"],
      cwd: "ios",
    });
    expect(composeBrief(classifyBuildLog(fixture("unknown-noise")), undefined).suggestion).toBeUndefined();
  });

  it("reads a watcher ENOSPC as the file-watcher limit, and a plain one as disk space", () => {
    const watchers = composeBrief(
      classifyBuildLog("> Task :app\nError: ENOSPC: System limit for number of file watchers reached, watch '/repo'"),
      undefined,
    );
    expect(watchers.category).toBe("memory");
    expect(watchers.suggestion?.text).toContain("file-watcher limit");
    const disk = composeBrief(classifyBuildLog("> Task :app\nError: ENOSPC: no space left on device"), undefined);
    expect(disk.suggestion?.text).toContain("disk space");
  });

  it("says line numbers count from the part ZLI read when the log was cut", () => {
    const brief = composeBrief(classifyBuildLog(fixture("gradle-unsupported-class-version")), undefined, {
      logCut: true,
    });
    expect(brief.logCut).toBe(true);
    expect(MobileBuildBrief.parse(brief)).toBeTruthy();
    expect(brief.text).toContain("First error, line 40 of the log's last 2 MB, the part ZLI read:");
  });

  it("keeps the brief to 4,000 characters by showing less of the log", () => {
    const long = Array.from({ length: 60 }, (_, index) => `> Task :lib${index}:compile ${"x".repeat(480)}`);
    long.splice(
      30,
      0,
      "e: Module was compiled with an incompatible version of Kotlin. The binary version of its metadata is 2.1.0, expected version is 1.9.0.",
    );
    const brief = composeBrief(classifyBuildLog(long.join("\n")), facts);
    expect(brief.text.length).toBeLessThanOrEqual(4_000);
    expect(brief.text).toContain("First error, line 31:");
    expect(brief.text).toContain("Avoid:");
  });
});
