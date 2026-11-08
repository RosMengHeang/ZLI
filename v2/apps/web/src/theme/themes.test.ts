// @vitest-environment jsdom

import { THEME_IDS, THEMES } from "@zli-v2/ui/themes";
import { afterEach, describe, expect, it } from "vitest";

import { applyTheme } from "./applyTheme.js";

function luminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

describe("themes", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("style");
    delete document.documentElement.dataset.theme;
  });

  it("sets the same tokens in every theme", () => {
    const names = Object.keys(THEMES.midnight.tokens).sort();
    for (const id of THEME_IDS) expect(Object.keys(THEMES[id].tokens).sort(), id).toEqual(names);
  });

  it.each(THEME_IDS)("%s keeps readable text on every surface", (id) => {
    const tokens = THEMES[id].tokens;
    const surfaces = ["--zli-canvas", "--zli-sidebar", "--zli-surface", "--zli-raised", "--zli-overlay"];
    for (const text of ["--zli-text", "--zli-muted", "--zli-dim"]) {
      for (const surface of surfaces) {
        const ratio = contrast(tokens[text] ?? "", tokens[surface] ?? "");
        expect(ratio, `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(
      contrast(tokens["--zli-accent-ink"] ?? "", tokens["--zli-accent"] ?? ""),
      "accent ink",
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("matches the terminal background to its tile", () => {
    for (const id of THEME_IDS) expect(THEMES[id].terminal.background).toBe(THEMES[id].tokens["--zli-terminal"]);
  });

  it("applies a theme to the root element", () => {
    applyTheme(THEMES.sakura);
    const root = document.documentElement;
    expect(root.dataset.theme).toBe("sakura");
    expect(root.style.getPropertyValue("--zli-accent")).toBe(THEMES.sakura.tokens["--zli-accent"]);
    applyTheme(THEMES.daylight);
    expect(root.style.getPropertyValue("--zli-canvas")).toBe(THEMES.daylight.tokens["--zli-canvas"]);
  });
});
