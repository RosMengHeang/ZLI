import { describe, expect, it } from "vitest";

import type { CliProbe } from "./discoverCliProviders.js";
import { createProviderRegistry, resolveClaudeCommand } from "./registerProviders.js";

describe("createProviderRegistry", () => {
  it("registers Codex and Claude Code, and leaves OpenCode unregistered", () => {
    const registry = createProviderRegistry({});
    expect(registry.list().map((adapter) => adapter.provider)).toEqual(["codex", "claude-code"]);
    expect(registry.get("opencode")).toBeUndefined();
    expect(registry.get("cursor-agent")).toBeUndefined();
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
