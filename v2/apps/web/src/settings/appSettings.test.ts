import { describe, expect, it } from "vitest";

import {
  type AppSettings,
  branchFromTemplate,
  DEFAULT_SETTINGS,
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
      sidebarLimits: { enabled: false, hidden: ["codex"] },
      theme: "midnight",
      customThemes: [],
      teammates: [],
      animateTeammates: true,
      tintProjects: true,
      chatTint: "card",
      archiveMergedChats: true,
      severalChats: false,
      layout: "columns",
    });
  });

  it("starts on Midnight and keeps a chosen theme", () => {
    expect(DEFAULT_SETTINGS.theme).toBe("midnight");
    expect(parseAppSettings(JSON.stringify({ theme: "sakura" })).theme).toBe("sakura");
  });

  it("keeps plan limits out of the sidebar until they are turned on", () => {
    expect(DEFAULT_SETTINGS.sidebarLimits).toEqual({ enabled: false, hidden: [] });
    expect(parseAppSettings(JSON.stringify({ sidebarLimits: { enabled: true } })).sidebarLimits).toEqual({
      enabled: true,
      hidden: [],
    });
    expect(
      parseAppSettings(JSON.stringify({ sidebarLimits: { enabled: true, pinned: "cursor-agent" } })).sidebarLimits,
    ).toEqual({ enabled: true, hidden: [], pinned: "cursor-agent" });
  });

  it("keeps the file tree on the right unless left was chosen", () => {
    expect(DEFAULT_SETTINGS.fileTreePosition).toBe("right");
    expect(parseAppSettings(JSON.stringify({ fileTreePosition: "left" })).fileTreePosition).toBe("left");
    expect(parseAppSettings(JSON.stringify({ fileTreePosition: "right" })).fileTreePosition).toBe("right");
  });

  it("colors project headings and chat cards unless the person turned them off", () => {
    expect(DEFAULT_SETTINGS.tintProjects).toBe(true);
    expect(parseAppSettings(JSON.stringify({})).tintProjects).toBe(true);
    expect(parseAppSettings(JSON.stringify({ tintProjects: false })).tintProjects).toBe(false);
    expect(DEFAULT_SETTINGS.chatTint).toBe("card");
    expect(parseAppSettings(JSON.stringify({ chatTint: "selection" })).chatTint).toBe("selection");
    expect(parseAppSettings(JSON.stringify({ chatTint: "loud" })).chatTint).toBe("card");
  });

  it("starts in the columns layout and keeps classic once chosen", () => {
    expect(parseAppSettings(null).layout).toBe("columns");
    expect(parseAppSettings(JSON.stringify({ layout: "classic" })).layout).toBe("classic");
    expect(parseAppSettings(JSON.stringify({ layout: "grid" })).layout).toBe("columns");
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
