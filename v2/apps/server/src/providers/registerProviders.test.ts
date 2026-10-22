import { describe, expect, it } from "vitest";

import type { CliProbe } from "./discoverCliProviders.js";
import {
  createProviderRegistry,
  resolveAcpCommand,
  resolveClaudeCommand,
  resolveCursorCommand,
  resolveDroidCommand,
} from "./registerProviders.js";

describe("createProviderRegistry", () => {
  it("registers Codex, Claude Code, Cursor, Droid, and the ACP agents", () => {
    const registry = createProviderRegistry({});
    expect(registry.list().map((adapter) => adapter.provider)).toEqual([
      "codex",
      "claude-code",
      "cursor-agent",
      "droid",
      "opencode",
      "gemini",
      "copilot",
      "kimi",
      "qwen",
      "goose",
    ]);
    for (const provider of ["opencode", "gemini", "copilot", "kimi", "qwen", "goose"] as const) {
      expect(registry.get(provider)?.capabilities).toEqual({
        exactResume: false,
        structuredApproval: true,
        structuredUserInput: false,
        conversationRollback: false,
        modelSwitch: "in-session",
      });
    }
    expect(registry.get("codex")?.capabilities).toMatchObject({
      exactResume: true,
      structuredApproval: true,
      conversationRollback: true,
    });
    expect(registry.get("claude-code")?.capabilities).toEqual({
      exactResume: false,
      structuredApproval: true,
      structuredUserInput: false,
      conversationRollback: false,
      modelSwitch: "in-session",
    });
    expect(registry.get("droid")?.capabilities).toEqual({
      exactResume: false,
      structuredApproval: false,
      structuredUserInput: false,
      conversationRollback: false,
      modelSwitch: "in-session",
      permissionSwitch: "in-session",
    });
    expect(registry.get("cursor-agent")?.capabilities).toEqual({
      exactResume: false,
      structuredApproval: false,
      structuredUserInput: false,
      conversationRollback: false,
      modelSwitch: "in-session",
      permissionSwitch: "in-session",
    });
  });

  it("keeps the integration harness on the mock provider", () => {
    const registry = createProviderRegistry({ ZLI_TEST_PROVIDER: "mock" });
    expect(registry.list().map((adapter) => adapter.provider)).toEqual(["codex"]);
  });
});

describe("resolveClaudeCommand", () => {
  it("returns the discovered Claude path and a typed error when discovery misses it", async () => {
    const found: CliProbe = {
      pathEntries: ["/tools"],
      platform: "linux",
      fileExists: (filePath) => filePath === "/tools/claude",
    };
    const missing: CliProbe = {
      pathEntries: [],
      platform: "linux",
      fileExists: () => false,
    };

    await expect(resolveClaudeCommand(found)).resolves.toBe("/tools/claude");
    await expect(resolveClaudeCommand(missing)).rejects.toMatchObject({
      code: "cli_missing",
      message: "Claude Code CLI was not found on PATH or in known install locations.",
    });
  });
});

describe("resolveCursorCommand", () => {
  it("returns the discovered Cursor path and a typed error when discovery misses it", async () => {
    const found: CliProbe = {
      pathEntries: ["/tools"],
      platform: "linux",
      fileExists: (filePath) => filePath === "/tools/cursor-agent",
    };
    const missing: CliProbe = {
      pathEntries: [],
      platform: "linux",
      fileExists: () => false,
    };

    await expect(resolveCursorCommand(found)).resolves.toBe("/tools/cursor-agent");
    await expect(resolveCursorCommand(missing)).rejects.toMatchObject({
      code: "cli_missing",
      message: "Cursor CLI was not found on PATH or in known install locations.",
    });
  });
});

describe("resolveAcpCommand", () => {
  it("returns the discovered Kimi Code path and a typed error when discovery misses Goose", async () => {
    const found: CliProbe = {
      pathEntries: [],
      homeDir: "C:\\Users\\dev",
      platform: "win32",
      fileExists: (filePath) => filePath === "C:\\Users\\dev\\.kimi-code\\bin\\kimi.exe",
    };
    await expect(resolveAcpCommand("kimi", found)).resolves.toBe("C:\\Users\\dev\\.kimi-code\\bin\\kimi.exe");
    await expect(resolveAcpCommand("goose", found)).rejects.toMatchObject({
      code: "cli_missing",
      message: "Goose CLI was not found on PATH or in known install locations.",
    });
  });
});

describe("resolveDroidCommand", () => {
  it("returns the discovered Droid path from ~/bin and a typed error when discovery misses it", async () => {
    const found: CliProbe = {
      pathEntries: [],
      homeDir: "C:\\Users\\dev",
      platform: "win32",
      fileExists: (filePath) => filePath === "C:\\Users\\dev\\bin\\droid.exe",
    };
    const missing: CliProbe = {
      pathEntries: [],
      platform: "linux",
      fileExists: () => false,
    };

    await expect(resolveDroidCommand(found)).resolves.toBe("C:\\Users\\dev\\bin\\droid.exe");
    await expect(resolveDroidCommand(missing)).rejects.toMatchObject({
      code: "cli_missing",
      message: "Droid CLI was not found on PATH or in known install locations.",
    });
  });
});
