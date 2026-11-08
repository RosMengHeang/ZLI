import type { HistoryFolder, ProviderDiscovery } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import {
  defaultAgent,
  preselect,
  folderState,
  importPlan,
  installCommand,
  installPlatform,
  landing,
  shouldWelcome,
  toggleFolder,
  welcomeAgents,
} from "./welcome.js";

const empty = { projects: [], threads: [], terminals: [] };

describe("shouldWelcome", () => {
  it("shows on a fresh install only", () => {
    expect(shouldWelcome(undefined, empty)).toBe(true);
    expect(shouldWelcome("2026-11-09T00:00:00.000Z", empty)).toBe(false);
    expect(shouldWelcome(undefined, undefined)).toBe(false);
    expect(shouldWelcome(undefined, { ...empty, projects: [{} as never] })).toBe(false);
    expect(shouldWelcome(undefined, { ...empty, terminals: [{} as never] })).toBe(false);
  });
});

describe("welcomeAgents", () => {
  const found = (provider: ProviderDiscovery["provider"]): ProviderDiscovery => ({
    provider,
    displayName: provider,
    status: "found",
    path: `/bin/${provider}`,
  });
  const missing = (provider: ProviderDiscovery["provider"]): ProviderDiscovery => ({
    provider,
    displayName: provider,
    status: "missing",
    reason: "not found",
  });

  it("lists ready agents first, keeps Claude Code and Codex, and folds away other missing ones", () => {
    const { shown, more } = welcomeAgents([missing("claude-code"), found("gemini"), found("codex"), missing("goose")]);
    expect(shown.map((entry) => entry.provider)).toEqual(["codex", "gemini", "claude-code"]);
    expect(more.map((entry) => entry.provider)).toEqual(["goose"]);
  });
});

describe("installCommand", () => {
  it("uses the platform's command and has none for agents without one", () => {
    expect(installCommand("claude-code", installPlatform("Mozilla/5.0 (Windows NT 10.0)"))).toContain("install.ps1");
    expect(installCommand("claude-code", installPlatform("Mozilla/5.0 (Macintosh)"))).toContain("install.sh");
    expect(installCommand("goose", "posix")).toBeUndefined();
  });
});

describe("chat selection", () => {
  const folder: HistoryFolder = {
    path: "/w/app",
    name: "app",
    exists: true,
    lastActiveAt: "2026-11-03T00:00:00.000Z",
    chats: [
      {
        source: "codex",
        providerSessionId: "b",
        title: "B",
        messageCount: 2,
        lastActiveAt: "2026-11-03T00:00:00.000Z",
      },
      {
        source: "claude-code",
        providerSessionId: "a",
        title: "A",
        messageCount: 4,
        lastActiveAt: "2026-11-01T00:00:00.000Z",
      },
      {
        source: "claude-code",
        providerSessionId: "c",
        title: "C",
        messageCount: 1,
        lastActiveAt: "2026-11-02T00:00:00.000Z",
        imported: true,
      },
    ],
  };

  it("toggles every chat that can still be imported, and plans oldest first", () => {
    const all = toggleFolder(new Set(), folder);
    expect([...all].sort()).toEqual(["claude-code:a", "codex:b"]);
    expect(folderState(all, folder)).toBe("all");
    expect(importPlan([folder], all)).toEqual([
      {
        path: "/w/app",
        name: "app",
        chats: [
          { source: "claude-code", providerSessionId: "a" },
          { source: "codex", providerSessionId: "b" },
        ],
      },
    ]);
    expect(folderState(toggleFolder(all, folder), folder)).toBe("none");
    expect(folderState(new Set(["codex:b"]), folder)).toBe("some");
  });

  it("skips folders that no longer exist", () => {
    const gone = { ...folder, exists: false };
    expect(folderState(toggleFolder(new Set(), gone), gone)).toBe("none");
    expect(importPlan([gone], new Set(["codex:b"]))).toEqual([]);
  });
});

describe("landing", () => {
  const imported = [
    { sessionId: "old", projectId: "p1", lastActiveAt: "2026-11-01T00:00:00.000Z" },
    { sessionId: "new", projectId: "p2", lastActiveAt: "2026-11-03T00:00:00.000Z" },
  ];

  it("starts an agent in the folder the person added", () => {
    expect(landing({ style: "chat", added: [{ projectId: "a" }], imported })).toEqual({
      kind: "start",
      projectId: "a",
    });
  });

  it("opens the newest imported chat for chat, and starts the CLI in its project for terminal", () => {
    expect(landing({ style: "chat", added: [], imported })).toEqual({
      kind: "show",
      sessionId: "new",
      projectId: "p2",
    });
    expect(landing({ style: "terminal", added: [], imported })).toEqual({ kind: "start", projectId: "p2" });
  });

  it("lands on the empty board when nothing was added", () => {
    expect(landing({ style: "chat", added: [], imported: [] })).toEqual({ kind: "none" });
  });
});

describe("automatic choices", () => {
  const found = (provider: ProviderDiscovery["provider"]): ProviderDiscovery => ({
    provider,
    displayName: provider,
    status: "found",
    path: `/bin/${provider}`,
  });

  it("starts with the saved agent when it is installed, else the first ready one", () => {
    const providers = [found("gemini"), found("codex")];
    expect(defaultAgent(providers, "gemini")?.provider).toBe("gemini");
    expect(defaultAgent(providers, "claude-code")?.provider).toBe("codex");
    expect(defaultAgent([], undefined)).toBeUndefined();
  });

  it("ticks every chat that can still come in", () => {
    const folder: HistoryFolder = {
      path: "/w",
      name: "w",
      exists: true,
      lastActiveAt: "2026-11-01T00:00:00.000Z",
      chats: [
        {
          source: "codex",
          providerSessionId: "a",
          title: "A",
          messageCount: 1,
          lastActiveAt: "2026-11-01T00:00:00.000Z",
        },
        {
          source: "codex",
          providerSessionId: "b",
          title: "B",
          messageCount: 1,
          lastActiveAt: "2026-11-01T00:00:00.000Z",
          imported: true,
        },
      ],
    };
    expect([...preselect([folder, { ...folder, path: "/gone", exists: false }])]).toEqual(["codex:a"]);
  });
});
