import type { HistoryFolder, ProviderDiscovery } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import {
  agentReady,
  allFolders,
  defaultAgent,
  installCommand,
  installPlatform,
  landingPath,
  planLabel,
  preselect,
  selectedFolders,
  shouldWelcome,
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

describe("projects", () => {
  const folder = (name: string, lastActiveAt: string): HistoryFolder => ({
    path: `/w/${name}`,
    name,
    lastActiveAt,
    sources: ["claude-code"],
  });
  const folders = [folder("new", "2026-11-03T00:00:00.000Z"), folder("old", "2026-11-01T00:00:00.000Z")];

  it("starts with nothing ticked, and Select all ticks every folder in list order", () => {
    expect([...preselect(folders)]).toEqual([]);
    expect([...allFolders(folders)]).toEqual(["/w/new", "/w/old"]);
    expect(selectedFolders(folders, new Set(["/w/old"])).map((entry) => entry.name)).toEqual(["old"]);
  });

  it("opens the agent in the folder added last, else the newest ticked folder", () => {
    expect(landingPath(folders, allFolders(folders), [{ path: "/picked" }])).toBe("/picked");
    expect(landingPath(folders, allFolders(folders), [])).toBe("/w/new");
    expect(landingPath(folders, new Set(["/w/old"]), [])).toBe("/w/old");
    expect(landingPath(folders, new Set(), [])).toBeUndefined();
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

  it("passes over a signed-out agent unless it is the only one installed", () => {
    const signedOut: ProviderDiscovery = {
      provider: "claude-code",
      displayName: "Claude Code",
      status: "found",
      path: "/bin/claude",
      login: { status: "signed-out" },
    };
    const codex: ProviderDiscovery = {
      provider: "codex",
      displayName: "Codex",
      status: "found",
      path: "/bin/codex",
      login: { status: "signed-in", email: "kim@example.com" },
    };
    expect(agentReady(signedOut)).toBe(false);
    expect(agentReady(found("gemini"))).toBe(true);
    expect(defaultAgent([signedOut, codex], "claude-code")?.provider).toBe("codex");
    expect(defaultAgent([signedOut], undefined)?.provider).toBe("claude-code");
  });

  it("names plans the way people read them", () => {
    expect(planLabel("pro")).toBe("Pro");
    expect(planLabel("team_plus")).toBe("Team Plus");
  });
});
