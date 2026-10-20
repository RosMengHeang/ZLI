import { describe, expect, it } from "vitest";

import type { CliProbe } from "./discoverCliProviders.js";
import {
  createProviderRegistry,
  resolveClaudeCommand,
  resolveCursorCommand,
  resolveDroidCommand,
} from "./registerProviders.js";

describe("createProviderRegistry", () => {
  it("registers Codex, Claude Code, Cursor, and Droid, and leaves OpenCode unregistered", () => {
    const registry = createProviderRegistry({});
    expect(registry.list().map((adapter) => adapter.provider)).toEqual([
      "codex",
      "claude-code",
      "cursor-agent",
      "droid",
    ]);
    expect(registry.get("opencode")).toBeUndefined();
    expect(registry.get("codex")?.capabilities).toMatchObject({
      exactResume: true,
      structuredApproval: true,
      conversationRollback: true,
    });
    expect(registry.get("claude-code")?.capabilities).toEqual({
      exactResume: false,
      structuredApproval: false,
      structuredUserInput: false,
      conversationRollback: false,
      modelSwitch: "unsupported",
    });
    expect(registry.get("droid")?.capabilities).toEqual({
      exactResume: false,
      structuredApproval: false,
      structuredUserInput: false,
      conversationRollback: false,
      modelSwitch: "unsupported",
    });
    expect(registry.get("cursor-agent")?.capabilities).toEqual({
      exactResume: false,
      structuredApproval: false,
      structuredUserInput: false,
      conversationRollback: false,
      modelSwitch: "unsupported",
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
