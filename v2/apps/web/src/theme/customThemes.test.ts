// @vitest-environment jsdom

import { contrastRatio, deriveBase, isLightColor, mixHex, THEMES } from "@zli-v2/ui/themes";
import { afterEach, describe, expect, it } from "vitest";

import { readAppSettings, updateAppSettings } from "../settings/appSettings.js";
import { activeTheme } from "./applyTheme.js";
import {
  buildCustomTheme,
  type CustomTheme,
  customThemeFrom,
  parseCustomThemes,
  readabilityProblems,
  resolveTheme,
} from "./customThemes.js";
import {
  closeThemeEditor,
  openThemeEditor,
  readThemeEditor,
  saveThemeEditor,
  updateThemeDraft,
} from "./themeEditorStore.js";

const rose: CustomTheme = {
  id: "custom-rose1",
  name: "Rose",
  basedOn: "sakura",
  seed: { background: "#120c10", terminal: "#18111a", accent: "#e9a3c4" },
  overrides: {},
};

describe("themes people make", () => {
  afterEach(() => {
    closeThemeEditor();
    window.localStorage.clear();
    updateAppSettings((current) => ({ ...current, theme: "midnight", customThemes: [] }));
  });

  it("keeps only well-formed themes from stored settings", () => {
    const parsed = parseCustomThemes([
      rose,
      { ...rose },
      { id: "custom-bad1", name: "No colors", seed: {} },
      { id: "not-custom", name: "Wrong id", seed: rose.seed },
      {
        ...rose,
        id: "custom-over1",
        overrides: { text: "#ffffff", raised: "red", canvas: "#111111", nope: "#000000" },
      },
    ]);
    expect(parsed.map((theme) => theme.id)).toEqual(["custom-rose1", "custom-over1"]);
    // The window, terminal, and accent colors live in the seed, never in overrides.
    expect(parsed[1]?.overrides).toEqual({ text: "#ffffff" });
  });

  it.each([
    ["#000000", "#4a6fdc"],
    ["#0f0b0d", "#e9a3c4"],
    ["#1a1f29", "#88c0d0"],
    ["#ececef", "#2f5fe0"],
    ["#fdf6e3", "#b58900"],
  ])("derives readable colors from %s and %s", (background, accent) => {
    // The terminal the same as the window, and a little lighter or darker than it.
    const near = isLightColor(background) ? "#ffffff" : mixHex(background, "#ffffff", 0.06);
    for (const terminal of [background, near]) {
      const base = deriveBase({ background, terminal, accent }, THEMES.midnight.base);
      expect(readabilityProblems(base), `terminal ${terminal}`).toEqual([]);
      expect(base.canvas).toBe(background);
      expect(base.surface).toBe(terminal);
    }
  });

  it("gives the terminal light text when it is dark, even in a light theme", () => {
    const theme = buildCustomTheme({
      ...rose,
      basedOn: "daylight",
      seed: { background: "#ececef", terminal: "#141414", accent: "#2f5fe0" },
    });
    expect(theme.scheme).toBe("light");
    expect(theme.terminal.background).toBe("#141414");
    expect(contrastRatio(theme.terminal.foreground, "#141414")).toBeGreaterThan(7);
  });

  it("turns a theme saved with a panel depth into a terminal color", () => {
    const [old] = parseCustomThemes([{ ...rose, seed: { background: "#000000", accent: "#e9a3c4", depth: 0 } }]);
    expect(old?.seed.terminal).toBe("#000000");
  });

  it("lets a color set by hand win over the derived one", () => {
    const theme = buildCustomTheme({ ...rose, overrides: { raised: "#222222" } });
    expect(theme.tokens["--zli-raised"]).toBe("#222222");
  });

  it("starts a new theme from a built-in one with its three colors", () => {
    const made = customThemeFrom(THEMES.frost, "My Frost");
    expect(made.basedOn).toBe("frost");
    expect(made.seed.background).toBe(THEMES.frost.base.canvas);
    expect(made.seed.accent).toBe(THEMES.frost.base.accent);
    expect(made.seed.terminal).toBe(THEMES.frost.base.surface);
    expect(made.id).toMatch(/^custom-/u);
  });

  it("falls back to the default when a chosen theme was deleted", () => {
    expect(resolveTheme("custom-gone1", [rose]).id).toBe("midnight");
    expect(resolveTheme(rose.id, [rose]).name).toBe("Rose");
  });

  it("previews the draft, then saves it as the current theme", () => {
    openThemeEditor(rose, true);
    updateThemeDraft((draft) => ({ ...draft, seed: { ...draft.seed, accent: "#c58fe0" } }));
    expect(activeTheme().tokens["--zli-accent"]).toBe("#c58fe0");
    expect(readAppSettings().customThemes).toEqual([]);

    saveThemeEditor();
    expect(readThemeEditor()).toBeUndefined();
    expect(readAppSettings().theme).toBe(rose.id);
    expect(readAppSettings().customThemes[0]?.seed.accent).toBe("#c58fe0");
  });

  it("brings the saved theme back when the editor is cancelled", () => {
    openThemeEditor(rose, true);
    closeThemeEditor();
    expect(activeTheme().id).toBe("midnight");
    expect(readAppSettings().customThemes).toEqual([]);
  });
});
