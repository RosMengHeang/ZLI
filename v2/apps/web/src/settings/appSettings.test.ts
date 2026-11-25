import { describe, expect, it } from "vitest";

import { DEFAULT_TYPOGRAPHY } from "../theme/typography.js";

import {
  type AppSettings,
  branchFromTemplate,
  DEFAULT_SETTINGS,
  DEFAULT_SIDEBAR_LOOK,
  parseAppSettings,
  resolveLaunchDefaults,
} from "./appSettings.js";

const settings = (patch: Partial<AppSettings>): AppSettings => ({ ...structuredClone(DEFAULT_SETTINGS), ...patch });

describe("app settings", () => {
  it("falls back to defaults for missing, broken, or mistyped values", () => {
    expect(parseAppSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseAppSettings("{not json")).toEqual(DEFAULT_SETTINGS);
    expect(
      parseAppSettings(
        JSON.stringify({
          defaults: { provider: "codex", mode: "window", permissionMode: "yolo", model: "gpt-5" },
          projects: { a: { model: "orphan" }, b: { permissionMode: "supervised" } },
          branchTemplate: "   ",
          shortcuts: { newAgent: "Mod+Shift+N", unknown: "Mod+U", palette: 3 },
          fileTreePosition: "top",
          sidebarLimits: { enabled: "yes", hidden: ["codex", "goose", 4], pinned: "goose" },
          theme: "neon",
        }),
      ),
    ).toEqual({
      defaults: { provider: "codex", model: "gpt-5" },
      projects: { b: { permissionMode: "supervised" } },
      branchTemplate: "{agent}-{random}",
      shortcuts: { newAgent: "Mod+Shift+N" },
      fileTreePosition: "right",
      sidebarLimits: { enabled: true, hidden: ["codex"] },
      theme: "system",
      customThemes: [],
      teammates: [],
      animateTeammates: true,
      tintProjects: true,
      chatTint: "card",
      archiveMergedChats: true,
      severalChats: false,
      layout: "classic",
      compactChats: true,
      sidebarView: "activity",
      sidebarLook: DEFAULT_SIDEBAR_LOOK,
      typography: DEFAULT_TYPOGRAPHY,
      chatBackdrop: { style: "glow", intensity: 60, imageEffect: "photo" },
      pinnedAgents: [],
      pinnedModels: [],
      autoCompact: { enabled: true, at: 0.85 },
    });
  });

  it("starts on System and keeps a chosen theme", () => {
    expect(DEFAULT_SETTINGS.theme).toBe("system");
    expect(parseAppSettings(JSON.stringify({ theme: "onyx" })).theme).toBe("onyx");
  });

  it("keeps plan limits out of the sidebar until they are turned on", () => {
    expect(DEFAULT_SETTINGS.sidebarLimits).toEqual({ enabled: true, hidden: [] });
    expect(parseAppSettings(JSON.stringify({ sidebarLimits: { enabled: true } })).sidebarLimits).toEqual({
      enabled: true,
      hidden: [],
    });
    expect(
      parseAppSettings(JSON.stringify({ sidebarLimits: { enabled: true, pinned: "cursor-agent" } })).sidebarLimits,
    ).toEqual({ enabled: true, hidden: [], pinned: "cursor-agent" });
  });

  it("compacts chats by itself at 85% unless the person changed it", () => {
    expect(parseAppSettings(null).autoCompact).toEqual({ enabled: true, at: 0.85 });
    expect(parseAppSettings(JSON.stringify({ autoCompact: { enabled: false, at: 0.7 } })).autoCompact).toEqual({
      enabled: false,
      at: 0.7,
    });
    expect(parseAppSettings(JSON.stringify({ autoCompact: { at: 2 } })).autoCompact).toEqual({
      enabled: true,
      at: 0.85,
    });
  });

  it("keeps the file tree on the right unless left was chosen", () => {
    expect(DEFAULT_SETTINGS.fileTreePosition).toBe("right");
    expect(parseAppSettings(JSON.stringify({ fileTreePosition: "left" })).fileTreePosition).toBe("left");
    expect(parseAppSettings(JSON.stringify({ fileTreePosition: "right" })).fileTreePosition).toBe("right");
  });

  it("colors project headings unless the person turned it off", () => {
    expect(DEFAULT_SETTINGS.tintProjects).toBe(true);
    expect(parseAppSettings(JSON.stringify({})).tintProjects).toBe(true);
    expect(parseAppSettings(JSON.stringify({ tintProjects: false })).tintProjects).toBe(false);
    expect(DEFAULT_SETTINGS.chatTint).toBe("card");
    expect(parseAppSettings(JSON.stringify({ chatTint: "selection" })).chatTint).toBe("selection");
    expect(parseAppSettings(JSON.stringify({ chatTint: "loud" })).chatTint).toBe("card");
  });

  it("starts in the rounded classic layout and keeps columns only once chosen", () => {
    expect(parseAppSettings(null).layout).toBe("classic");
    // Columns saved before anyone chose it was the old default: it moves to classic.
    expect(parseAppSettings(JSON.stringify({ layout: "columns" })).layout).toBe("classic");
    expect(parseAppSettings(JSON.stringify({ layout: "columns", layoutChosen: true })).layout).toBe("columns");
    expect(parseAppSettings(JSON.stringify({ layout: "grid" })).layout).toBe("classic");
  });

  it("prefers project settings, then general defaults, then the last launch", () => {
    const value = settings({
      defaults: { provider: "codex", model: "gpt-5", mode: "chat" },
      projects: { p1: { provider: "claude-code", permissionMode: "supervised" } },
    });
    expect(resolveLaunchDefaults(value, "p1", { mode: "terminal", permissionMode: "full-access" })).toEqual({
      provider: "claude-code",
      mode: "chat",
      permissionMode: "supervised",
    });
    expect(resolveLaunchDefaults(value, "p2", { provider: "droid", permissionMode: "full-access" })).toEqual({
      provider: "codex",
      model: "gpt-5",
      mode: "chat",
      permissionMode: "full-access",
    });
    expect(resolveLaunchDefaults(settings({}), undefined, { provider: "droid" })).toEqual({ provider: "droid" });
  });

  it("fills branch templates and keeps the result a valid branch name", () => {
    const now = new Date(2026, 0, 5);
    const random = () => "ab12";
    expect(branchFromTemplate("{agent}-{random}", "claude-code", now, random)).toBe("claude-ab12");
    expect(branchFromTemplate("zli/{date}-{agent}", "codex", now, random)).toBe("zli/20260105-codex");
    expect(branchFromTemplate("my task: {agent}?", "cursor-agent", now, random)).toBe("my-task-cursor");
    expect(branchFromTemplate("../a//b..c.lock/", undefined, now, random)).toBe("a/b.c");
    expect(branchFromTemplate("~^:", "droid", now, random)).toBe("droid-ab12");
  });
});
