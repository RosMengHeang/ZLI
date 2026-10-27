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
          sidebarLimits: { enabled: "yes", hidden: ["codex", "droid", 4] },
        }),
      ),
    ).toEqual({
      defaults: { provider: "codex", model: "gpt-5" },
      projects: { b: { permissionMode: "supervised" } },
      branchTemplate: "{agent}-{random}",
      shortcuts: { newAgent: "Mod+Shift+N" },
      fileTreePosition: "right",
      sidebarLimits: { enabled: false, hidden: ["codex"] },
    });
  });

  it("keeps plan limits out of the sidebar until they are turned on", () => {
    expect(DEFAULT_SETTINGS.sidebarLimits).toEqual({ enabled: false, hidden: [] });
    expect(parseAppSettings(JSON.stringify({ sidebarLimits: { enabled: true } })).sidebarLimits).toEqual({
      enabled: true,
      hidden: [],
    });
  });

  it("keeps the file tree on the right unless left was chosen", () => {
    expect(DEFAULT_SETTINGS.fileTreePosition).toBe("right");
    expect(parseAppSettings(JSON.stringify({ fileTreePosition: "left" })).fileTreePosition).toBe("left");
    expect(parseAppSettings(JSON.stringify({ fileTreePosition: "right" })).fileTreePosition).toBe("right");
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
