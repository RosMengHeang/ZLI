import { describe, expect, it } from "vitest";

import { FakeProcessRunner } from "../../FakeProcessRunner.js";
import { createMobileDev } from "../index.js";
import { createTestDevHost } from "../testHost.js";
import { deepPlan, lastDeep, parseStep, runDeep } from "./deepCheck.js";
import { projectFacts } from "./facts.js";
import { fixtureFiles } from "./testFixtures.js";

const BINS = { "/repo/app/node_modules/.bin/expo": "", "/repo/app/node_modules/.bin/expo-doctor": "" };

function answers() {
  return new FakeProcessRunner((command, args) => {
    if (command !== "npx") return undefined;
    const line = args.join(" ");
    if (line.includes("expo config"))
      return { stdout: JSON.stringify({ name: "Devclient", sdkVersion: "56.0.0", newArchEnabled: true }) };
    if (line.includes("install --check"))
      return {
        code: 1,
        stdout:
          "The following packages should be updated for best compatibility with the installed expo version:\n  react-native-reanimated@3.10.0 - expected version: ~4.1.0\n  @shopify/flash-list@1.6.0 - expected version: 2.0.2\nYour project may not work correctly until you install the expected versions of the packages.\n",
      };
    if (line.includes("expo-doctor"))
      return {
        code: 1,
        stdout:
          "\u001b[32m✔\u001b[0m Check package.json for common issues\n\u001b[31m✖\u001b[0m Check that packages match versions required by installed Expo SDK\n✖ Validate packages against React Native Directory package metadata\n2 checks failed, indicating possible issues with the project.\n",
      };
    return undefined;
  });
}

describe("Expo checks", () => {
  it("shows the exact command lines and the folder before anything runs", async () => {
    const host = createTestDevHost({ files: fixtureFiles("monorepo-apps-mobile") });
    expect(await deepPlan(host, "wt-1")).toEqual({
      folder: "apps/mobile",
      commands: [
        "npx --no-install expo config --json --type public",
        "CI=1 npx --no-install expo install --check",
        "npx --no-install expo-doctor",
      ],
    });
    expect(host.runner.calls).toEqual([]);
  });

  it("never runs them from the doctor's facts or the agent action", async () => {
    const host = createTestDevHost({ files: { ...fixtureFiles("expo56-devclient"), ...BINS }, runner: answers() });
    await projectFacts(host, "wt-1");
    const dev = createMobileDev(host);
    await dev.ipc["zli:mobile:doctor:check"]?.({ worktreeId: "wt-1" });
    expect(host.runner.calls.filter((call) => call.command === "npx")).toEqual([]);
  });

  it("says Not installed in this project when the local binaries are missing, without running npx", async () => {
    const host = createTestDevHost({ files: fixtureFiles("expo56-devclient"), runner: answers() });
    const result = await runDeep(host, "wt-1");
    expect(result.expoConfig).toEqual({ ok: false, state: "not-installed", detail: "Not installed in this project." });
    expect(result.expoDoctor?.state).toBe("not-installed");
    expect(host.runner.calls.filter((call) => call.command === "npx")).toEqual([]);
  });

  it("runs the three checks in the app folder, parses them, and keeps the results for the doctor", async () => {
    const host = createTestDevHost({ files: { ...fixtureFiles("expo56-devclient"), ...BINS }, runner: answers() });
    const result = await runDeep(host, "wt-1");
    expect(result).toEqual({
      ranAt: "2026-01-02T03:04:05.000Z",
      expoConfig: { ok: true, state: "passed", sdkVersion: "56.0.0" },
      expoInstallCheck: expect.objectContaining({
        ok: false,
        state: "failed",
        packages: ["react-native-reanimated", "@shopify/flash-list"],
      }),
      expoDoctor: {
        ok: false,
        state: "failed",
        failures: [
          "Check that packages match versions required by installed Expo SDK",
          "Validate packages against React Native Directory package metadata",
        ],
      },
    });
    const calls = host.runner.calls.filter((call) => call.command === "npx");
    expect(calls.map((call) => call.args.join(" "))).toEqual([
      "--no-install expo config --json --type public",
      "--no-install expo install --check",
      "--no-install expo-doctor",
    ]);
    expect(calls.map((call) => (call.options as { env: Record<string, string> }).env.CI)).toEqual([
      undefined,
      "1",
      undefined,
    ]);
    expect(calls.every((call) => (call.options as { cwd: string; timeoutMs: number }).cwd === "/repo/app")).toBe(true);
    expect(lastDeep(host, "wt-1")).toEqual(result);
    const facts = await projectFacts(host, "wt-1");
    expect(facts?.deep).toEqual(result);
    expect(facts?.findings.map((finding) => finding.id)).toContain("expo-install-check");
  });

  it("reports a timeout and output it cannot parse", async () => {
    const host = createTestDevHost({
      files: { ...fixtureFiles("expo56-devclient"), ...BINS },
      runner: new FakeProcessRunner((command) => (command === "npx" ? { timedOut: true, code: null } : undefined)),
    });
    expect((await runDeep(host, "wt-1")).expoConfig).toEqual({
      ok: false,
      state: "timed-out",
      detail: "Did not finish in 60 seconds.",
    });
    expect(parseStep("expoConfig", 0, "not json", "")).toMatchObject({
      ok: false,
      state: "failed",
      detail: "not json",
    });
    expect(parseStep("expoDoctor", 0, "Didn't find any issues with the project!", "")).toEqual({
      ok: true,
      state: "passed",
      failures: [],
    });
  });
});
