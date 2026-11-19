import { describe, expect, it } from "vitest";

import { installCommand, installHint, installPage } from "./providerInstall.js";

describe("provider install hints", () => {
  it("has a command for Cursor and Droid on both platforms", () => {
    expect(installCommand("cursor-agent", "windows")).toBe("irm 'https://cursor.com/install?win32=true' | iex");
    expect(installCommand("droid", "posix")).toBe("curl -fsSL https://app.factory.ai/cli | sh");
  });

  it("links the install page for agents without one command", () => {
    expect(installCommand("kimi", "posix")).toBeUndefined();
    expect(installPage("kimi")).toBe("https://github.com/MoonshotAI/kimi-cli");
    expect(installHint("kimi", "windows")).toBe(
      "Install it from https://github.com/MoonshotAI/kimi-cli, then try again.",
    );
  });

  it("gives every agent a hint", () => {
    const providers = [
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
      "grok",
    ] as const;
    for (const provider of providers) expect(installHint(provider, "posix")).toBeTruthy();
  });
});
