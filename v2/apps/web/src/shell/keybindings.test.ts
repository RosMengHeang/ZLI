import { describe, expect, it } from "vitest";

import { matchesShortcut, resolveShortcuts, shortcutFromEvent, shortcutProblem } from "./keybindings.js";

const key = (init: Partial<KeyboardEvent> & { key: string; code: string }) => ({
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...init,
});

describe("keybindings", () => {
  it("writes key presses the way shortcuts are stored", () => {
    expect(shortcutFromEvent(key({ key: "n", code: "KeyN", ctrlKey: true }))).toBe("Mod+N");
    expect(shortcutFromEvent(key({ key: "F", code: "KeyF", metaKey: true, shiftKey: true }))).toBe("Mod+Shift+F");
    expect(shortcutFromEvent(key({ key: "!", code: "Digit1", ctrlKey: true, shiftKey: true }))).toBe("Mod+Shift+1");
    expect(shortcutFromEvent(key({ key: ",", code: "Comma", ctrlKey: true }))).toBe("Mod+,");
    expect(shortcutFromEvent(key({ key: "\u00e5", code: "KeyA", altKey: true }))).toBe("Alt+A");
    expect(shortcutFromEvent(key({ key: "Control", code: "ControlLeft", ctrlKey: true }))).toBeUndefined();
  });

  it("matches exactly, so extra modifiers do not trigger a shortcut", () => {
    expect(matchesShortcut(key({ key: "k", code: "KeyK", ctrlKey: true }), "Mod+K")).toBe(true);
    expect(matchesShortcut(key({ key: "K", code: "KeyK", ctrlKey: true, shiftKey: true }), "Mod+K")).toBe(false);
    expect(matchesShortcut(key({ key: "k", code: "KeyK" }), "Mod+K")).toBe(false);
  });

  it("applies overrides on top of the defaults", () => {
    const bindings = resolveShortcuts({ newAgent: "Mod+Shift+N" });
    expect(bindings.newAgent).toBe("Mod+Shift+N");
    expect(bindings.palette).toBe("Mod+K");
  });

  it("refuses shortcuts that would break typing, editing, or another shortcut", () => {
    expect(shortcutProblem({}, "newAgent", "Shift+N")).toMatch(/Include Ctrl, Cmd, or Alt/u);
    expect(shortcutProblem({}, "newAgent", "Mod+C")).toBe("This key is kept for copy.");
    expect(shortcutProblem({}, "newAgent", "Mod+=")).toBe("This key is kept for zooming in.");
    expect(shortcutProblem({}, "newAgent", "Mod+K")).toBe("Already used by Command palette.");
    expect(shortcutProblem({ palette: "Mod+Shift+P" }, "newAgent", "Mod+K")).toBeUndefined();
    expect(shortcutProblem({}, "newAgent", "Mod+N")).toBeUndefined();
    expect(shortcutProblem({}, "newAgent", "F6")).toBeUndefined();
  });
});
