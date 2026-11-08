import { describe, expect, it } from "vitest";

import { FakeProcessRunner } from "../../FakeProcessRunner.js";
import { createTestDevHost } from "../testHost.js";
import { javaMajor, PROBE_TIMEOUT_MS, probeHost } from "./probes.js";

function runner() {
  return new FakeProcessRunner((command) => {
    switch (command) {
      case "node":
        return { stdout: "v24.22.1\n" };
      case "java":
        return { stderr: 'openjdk version "17.0.12" 2024-07-16\nOpenJDK Runtime Environment' };
      case "adb":
        throw Object.assign(new Error("spawn adb ENOENT"), { code: "ENOENT" });
      case "xcodebuild":
        return { stdout: "Xcode 26.1\nBuild version 17B55\n" };
      case "pod":
        return { timedOut: true, code: null };
      case "security":
        return {
          stdout:
            '  1) 0123456789ABCDEF0123456789ABCDEF01234567 "Apple Development: Person (TEAM123)"\n  2) FEDCBA "Apple Distribution: Org"\n     2 valid identities found\n',
        };
      default:
        return undefined;
    }
  });
}

describe("host probes", () => {
  it("reads versions on Linux and does not run the Mac-only tools", async () => {
    const fake = runner();
    const host = createTestDevHost({ runner: fake });
    const probe = await probeHost(host);
    expect(probe).toEqual({
      tools: { node: "24.22.1", java: "17.0.12", adb: "not found", xcode: "not checked", cocoapods: "not checked" },
      iosIdentities: undefined,
    });
    expect(fake.calls.map((call) => call.command)).toEqual(["node", "java", "adb"]);
    for (const call of fake.calls) {
      expect(call.options).toMatchObject({ env: host.env, timeoutMs: PROBE_TIMEOUT_MS });
      expect(Object.keys((call.options as { env: object }).env)).not.toContain("ZLI_RUNTIME_TOKEN");
    }
  });

  it("on a Mac, keeps only the count of signing identities and reports a timed-out tool as not found", async () => {
    const host = createTestDevHost({ runner: runner(), os: "macos" });
    const probe = await probeHost(host);
    expect(probe.tools).toMatchObject({ xcode: "26.1", cocoapods: "not found" });
    expect(probe.iosIdentities).toBe(2);
    expect(JSON.stringify(probe)).not.toContain("Apple Development");
  });

  it("caches answers for a minute unless asked to refresh", async () => {
    const fake = runner();
    const host = createTestDevHost({ runner: fake });
    await probeHost(host);
    await probeHost(host);
    expect(fake.calls).toHaveLength(3);
    await probeHost(host, { refresh: true });
    expect(fake.calls).toHaveLength(6);
  });

  it("reports a tool that fails as not found", async () => {
    const host = createTestDevHost({ runner: new FakeProcessRunner(() => ({ code: 1, stderr: "boom" })) });
    expect((await probeHost(host)).tools.node).toBe("not found");
  });

  it("reads the Java major version in both numbering schemes", () => {
    expect(javaMajor("17.0.12")).toBe(17);
    expect(javaMajor("1.8.0_391")).toBe(8);
    expect(javaMajor(undefined)).toBeUndefined();
  });
});
