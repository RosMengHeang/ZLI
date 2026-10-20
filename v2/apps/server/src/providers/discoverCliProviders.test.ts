import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { describe, expect, it } from "vitest";

import {
  type CliProbe,
  createDefaultCliProbe,
  discoverCliProviders,
  fileLooksExecutable,
  readCliVersion,
} from "./discoverCliProviders.js";

function probe(overrides: Partial<CliProbe> & Pick<CliProbe, "fileExists">): CliProbe {
  return {
    pathEntries: [],
    platform: "linux",
    ...overrides,
  };
}

describe("discoverCliProviders", () => {
  it("reports a CLI found on PATH, including a version when the probe returns one", async () => {
    const versionCalls: string[] = [];
    const discovery = await discoverCliProviders(
      probe({
        pathEntries: ["/tools", "/later"],
        fileExists: (filePath) => filePath === "/tools/claude" || filePath === "/later/codex",
        readVersion: async (command) => {
          versionCalls.push(command);
          return command.endsWith("/claude") ? "claude 2.1.0\nextra" : undefined;
        },
      }),
    );

    expect(discovery).toEqual([
      {
        provider: "codex",
        displayName: "Codex",
        status: "found",
        path: "/later/codex",
      },
      {
        provider: "claude-code",
        displayName: "Claude Code",
        status: "found",
        path: "/tools/claude",
        version: "claude 2.1.0",
      },
      {
        provider: "cursor-agent",
        displayName: "Cursor",
        status: "missing",
        reason: "Cursor CLI was not found on PATH or in known install locations.",
      },
      {
        provider: "droid",
        displayName: "Droid",
        status: "missing",
        reason: "Droid CLI was not found on PATH or in known install locations.",
      },
    ]);
    expect(versionCalls).toEqual(["/later/codex", "/tools/claude"]);
    expect(discovery.map((entry) => entry.provider)).not.toContain("opencode");
  });

  it("reports every listed CLI missing without reading versions", async () => {
    const versionCalls: string[] = [];
    const discovery = await discoverCliProviders(
      probe({
        pathEntries: ["/empty"],
        homeDir: "/home/dev",
        fileExists: () => false,
        readVersion: async (command) => {
          versionCalls.push(command);
          return "should-not-run";
        },
      }),
    );

    expect(discovery.map((entry) => entry.status)).toEqual(["missing", "missing", "missing", "missing"]);
    expect(discovery.map((entry) => ("reason" in entry ? entry.reason : ""))).toEqual([
      "Codex CLI was not found on PATH or in known install locations.",
      "Claude Code CLI was not found on PATH or in known install locations.",
      "Cursor CLI was not found on PATH or in known install locations.",
      "Droid CLI was not found on PATH or in known install locations.",
    ]);
    expect(versionCalls).toEqual([]);
  });

  it("prefers PATH and falls back to known install locations", async () => {
    const discovery = await discoverCliProviders(
      probe({
        pathEntries: ["/usr/bin"],
        homeDir: "/home/dev",
        fileExists: (filePath) =>
          filePath === "/usr/bin/codex" ||
          filePath === "/home/dev/.local/bin/codex" ||
          filePath === "/home/dev/.claude/local/claude" ||
          filePath === "/opt/homebrew/bin/cursor-agent" ||
          filePath === "/home/dev/bin/droid",
      }),
    );

    expect(discovery).toEqual([
      { provider: "codex", displayName: "Codex", status: "found", path: "/usr/bin/codex" },
      { provider: "claude-code", displayName: "Claude Code", status: "found", path: "/home/dev/.claude/local/claude" },
      { provider: "cursor-agent", displayName: "Cursor", status: "found", path: "/opt/homebrew/bin/cursor-agent" },
      { provider: "droid", displayName: "Droid", status: "found", path: "/home/dev/bin/droid" },
    ]);
  });

  it("accepts a Cursor agent alias only inside a Cursor install directory", async () => {
    const onPath = await discoverCliProviders(
      probe({
        pathEntries: ["/usr/bin"],
        fileExists: (filePath) => filePath.endsWith("/agent"),
      }),
    );
    expect(onPath.find((entry) => entry.provider === "cursor-agent")).toMatchObject({ status: "missing" });

    const installed = await discoverCliProviders(
      probe({
        homeDir: "/home/dev",
        fileExists: (filePath) => filePath === "/home/dev/.cursor/bin/agent",
      }),
    );
    expect(installed.find((entry) => entry.provider === "cursor-agent")).toEqual({
      provider: "cursor-agent",
      displayName: "Cursor",
      status: "found",
      path: "/home/dev/.cursor/bin/agent",
    });
  });

  it("finds Windows CLI shims by extension without starting them", async () => {
    const claudeCmd = win32.join("C:\\Tools", "claude.cmd");
    const discovery = await discoverCliProviders(
      probe({
        platform: "win32",
        pathEntries: ["C:\\Tools"],
        homeDir: "C:\\Users\\dev",
        localAppData: "C:\\Users\\dev\\AppData\\Local",
        fileExists: (filePath) =>
          filePath === claudeCmd ||
          filePath === "C:\\Users\\dev\\AppData\\Local\\cursor-agent\\agent.exe" ||
          filePath === "C:\\Users\\dev\\bin\\droid.exe",
      }),
    );

    expect(discovery.find((entry) => entry.provider === "claude-code")).toEqual({
      provider: "claude-code",
      displayName: "Claude Code",
      status: "found",
      path: claudeCmd,
    });
    expect(discovery.find((entry) => entry.provider === "cursor-agent")).toMatchObject({
      status: "found",
      path: "C:\\Users\\dev\\AppData\\Local\\cursor-agent\\agent.exe",
    });
    expect(discovery.find((entry) => entry.provider === "droid")).toMatchObject({
      status: "found",
      path: "C:\\Users\\dev\\bin\\droid.exe",
    });
  });

  it("keeps a found CLI when the version probe fails", async () => {
    const discovery = await discoverCliProviders(
      probe({
        pathEntries: ["/tools"],
        fileExists: (filePath) => filePath === "/tools/codex",
        readVersion: async () => {
          throw new Error("version probe failed");
        },
      }),
    );
    expect(discovery[0]).toEqual({ provider: "codex", displayName: "Codex", status: "found", path: "/tools/codex" });
  });
});

describe("CLI probe helpers", () => {
  it("splits PATH with the platform delimiter and home directory", () => {
    const cli = createDefaultCliProbe({ PATH: "C:\\a;C:\\b", USERPROFILE: "C:\\Users\\dev" }, "win32");
    expect(cli.pathEntries).toEqual(["C:\\a", "C:\\b"]);
    expect(cli.homeDir).toBe("C:\\Users\\dev");
  });

  it("reports a synthetic Codex CLI when the mock provider is selected", async () => {
    const linux = await discoverCliProviders(createDefaultCliProbe({ ZLI_TEST_PROVIDER: "mock" }, "linux"));
    expect(linux).toEqual([
      {
        provider: "codex",
        displayName: "Codex",
        status: "found",
        path: "/zli/mock-provider/codex",
        version: "codex mock",
      },
      {
        provider: "claude-code",
        displayName: "Claude Code",
        status: "missing",
        reason: "Claude Code CLI was not found on PATH or in known install locations.",
      },
      {
        provider: "cursor-agent",
        displayName: "Cursor",
        status: "missing",
        reason: "Cursor CLI was not found on PATH or in known install locations.",
      },
      {
        provider: "droid",
        displayName: "Droid",
        status: "missing",
        reason: "Droid CLI was not found on PATH or in known install locations.",
      },
    ]);

    const windows = await discoverCliProviders(createDefaultCliProbe({ ZLI_TEST_PROVIDER: "mock" }, "win32"));
    expect(windows[0]).toEqual({
      provider: "codex",
      displayName: "Codex",
      status: "found",
      path: "C:\\zli\\mock-provider\\codex.exe",
      version: "codex mock",
    });
    expect(windows.filter((entry) => entry.provider !== "codex").map((entry) => entry.status)).toEqual([
      "missing",
      "missing",
      "missing",
    ]);
  });

  it.skipIf(process.platform === "win32")("requires the executable bit for unix files", () => {
    const dir = mkdtempSync(join(tmpdir(), "zli-cli-"));
    const bin = join(dir, "codex");
    writeFileSync(bin, "");
    chmodSync(bin, 0o644);
    expect(fileLooksExecutable(bin, "linux")).toBe(false);
    chmodSync(bin, 0o755);
    expect(fileLooksExecutable(bin, "linux")).toBe(true);
    expect(fileLooksExecutable(join(dir, "missing"), "linux")).toBe(false);
  });

  it("reads the first version line and stops a probe that does not exit", async () => {
    await expect(readCliVersion(process.execPath, ["-e", "process.stdout.write('claude 2.0.1\\nrest')"])).resolves.toBe(
      "claude 2.0.1",
    );
    await expect(readCliVersion(process.execPath, ["-e", "setInterval(() => {}, 1000)"], 100)).resolves.toBeUndefined();
  });
});
