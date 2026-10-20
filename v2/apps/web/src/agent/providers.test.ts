import type { ProviderDiscovery } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import { listedDiscoveries, preferredProvider, providerDisplayName, worktreeProviderLabel } from "./providers.js";

const codex: ProviderDiscovery = {
  provider: "codex",
  displayName: "Codex",
  status: "missing",
  reason: "Codex CLI was not found on PATH or in known install locations.",
};
const claude: ProviderDiscovery = {
  provider: "claude-code",
  displayName: "Claude Code",
  status: "found",
  path: "/home/dev/.local/bin/claude",
  version: "claude 2.1.0",
};
const cursor: ProviderDiscovery = {
  provider: "cursor-agent",
  displayName: "Cursor",
  status: "missing",
  reason: "Cursor CLI was not found on PATH or in known install locations.",
};
const droid: ProviderDiscovery = {
  provider: "droid",
  displayName: "Droid",
  status: "found",
  path: "C:\\Users\\dev\\bin\\droid.exe",
};

describe("listedDiscoveries", () => {
  it("lists every supported agent CLI and drops unknown ones", () => {
    const mixed = [
      codex,
      claude,
      cursor,
      droid,
      { provider: "opencode", displayName: "OpenCode", status: "found", path: "/usr/local/bin/opencode" },
      { provider: "kimi", displayName: "Kimi", status: "missing", reason: "Kimi CLI was not found." },
      { provider: "aider", displayName: "Aider", status: "found", path: "/usr/local/bin/aider" },
    ] as unknown as ProviderDiscovery[];

    expect(listedDiscoveries(mixed).map((entry) => entry.provider)).toEqual([
      "codex",
      "claude-code",
      "cursor-agent",
      "droid",
      "opencode",
      "kimi",
    ]);
    expect(listedDiscoveries(undefined)).toEqual([]);
  });

  it("names new agents before discovery reports them", () => {
    expect(providerDisplayName("gemini", undefined)).toBe("Gemini");
    expect(providerDisplayName("qwen", [])).toBe("Qwen Code");
  });

  it("prefers the first CLI discovery already found", () => {
    expect(preferredProvider([codex, claude, cursor])).toBe("claude-code");
    expect(preferredProvider([codex, cursor])).toBe("codex");
    expect(preferredProvider([codex, cursor, droid])).toBe("droid");
  });

  it("labels a worktree with the agents that have a thread there", () => {
    expect(
      worktreeProviderLabel(
        [
          { worktreeId: "tree-1", provider: "codex", status: "idle" },
          { worktreeId: "tree-1", provider: "claude-code", status: "working" },
          { worktreeId: "tree-1", provider: "cursor-agent", status: "stopped" },
          { worktreeId: "tree-1", provider: "aider", status: "idle" },
          { worktreeId: "tree-2", provider: "cursor-agent", status: "idle" },
        ],
        "tree-1",
        [codex, claude, cursor],
      ),
    ).toBe("Codex, Claude Code");
  });
});
