import type { ProviderDiscovery } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import { listedDiscoveries, preferredProvider, worktreeProviderLabel } from "./providers.js";

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

describe("listedDiscoveries", () => {
  it("keeps Codex, Claude Code, and Cursor, and drops OpenCode", () => {
    const mixed = [
      codex,
      claude,
      cursor,
      { provider: "opencode", displayName: "OpenCode", status: "found", path: "/usr/local/bin/opencode" },
    ] as ProviderDiscovery[];

    expect(listedDiscoveries(mixed).map((entry) => entry.provider)).toEqual(["codex", "claude-code", "cursor-agent"]);
    expect(listedDiscoveries(mixed).some((entry) => entry.displayName === "OpenCode")).toBe(false);
    expect(listedDiscoveries(undefined)).toEqual([]);
  });

  it("prefers the first CLI discovery already found", () => {
    expect(preferredProvider([codex, claude, cursor])).toBe("claude-code");
    expect(preferredProvider([codex, cursor])).toBe("codex");
  });

  it("labels a worktree with the agents that have a thread there", () => {
    expect(
      worktreeProviderLabel(
        [
          { worktreeId: "tree-1", provider: "codex" },
          { worktreeId: "tree-1", provider: "claude-code" },
          { worktreeId: "tree-1", provider: "opencode" },
          { worktreeId: "tree-2", provider: "cursor-agent" },
        ],
        "tree-1",
        [codex, claude, cursor],
      ),
    ).toBe("Codex, Claude Code");
  });
});
