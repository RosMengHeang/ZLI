// @vitest-environment jsdom

import { contrastRatio, deriveBase, THEMES } from "@zli-v2/ui/themes";
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
  seed: { background: "#120c10", accent: "#e9a3c4", depth: 0.4 },
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
      { ...rose, id: "custom-over1", overrides: { text: "#ffffff", canvas: "red", nope: "#000000" } },
    ]);
    expect(parsed.map((theme) => theme.id)).toEqual(["custom-rose1", "custom-over1"]);
    expect(parsed[1]?.overrides).toEqual({ text: "#ffffff" });
  });

  it.each([
    ["#000000", "#4a6fdc"],
    ["#0f0b0d", "#e9a3c4"],
    ["#1a1f29", "#88c0d0"],
    ["#ececef", "#2f5fe0"],
    ["#fdf6e3", "#b58900"],
  ])("derives readable colors from %s and %s", (background, accent) => {
    for (const depth of [0, 0.5, 1]) {
      const base = deriveBase({ background, accent, depth }, THEMES.midnight.base);
      expect(readabilityProblems(base), `depth ${depth}`).toEqual([]);
      expect(base.canvas).toBe(background);
    }
  });

  it("lifts panels off the window as depth grows", () => {
    const flat = deriveBase({ ...rose.seed, depth: 0 }, THEMES.sakura.base);
    const lifted = deriveBase({ ...rose.seed, depth: 1 }, THEMES.sakura.base);
    expect(flat.surface).toBe(rose.seed.background);
    expect(contrastRatio(lifted.surface, lifted.canvas)).toBeGreaterThan(contrastRatio(flat.surface, flat.canvas));
  });

  it("lets a color set by hand win over the derived one", () => {
    const theme = buildCustomTheme({ ...rose, overrides: { surface: "#222222" } });
    expect(theme.tokens["--zli-surface"]).toBe("#222222");
    expect(theme.terminal.background).toBe("#222222");
  });

  it("starts a new theme from a built-in one with its two colors", () => {
    const made = customThemeFrom(THEMES.frost, "My Frost");
    expect(made.basedOn).toBe("frost");
    expect(made.seed.background).toBe(THEMES.frost.base.canvas);
    expect(made.seed.accent).toBe(THEMES.frost.base.accent);
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
