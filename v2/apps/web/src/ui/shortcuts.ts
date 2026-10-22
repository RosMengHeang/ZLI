const isMac =
  typeof navigator !== "undefined" && /mac|iphone|ipad/iu.test(navigator.platform || navigator.userAgent || "");

const macSymbols: Record<string, string> = { Mod: "\u2318", Shift: "\u21e7", Alt: "\u2325", Enter: "\u21b5" };

/** Splits a shortcut such as "Mod+Shift+F" into the key caps shown on this platform. */
export function shortcutKeys(shortcut: string): string[] {
  return shortcut.split("+").map((key) => (isMac ? (macSymbols[key] ?? key) : key === "Mod" ? "Ctrl" : key));
}

/** The shortcut as one string, for tooltips and accessible descriptions. */
export function shortcutText(shortcut: string): string {
  return shortcutKeys(shortcut).join(isMac ? "" : "+");
}

/** The value for aria-keyshortcuts, which uses the platform's real modifier names. */
export function ariaShortcut(shortcut: string): string {
  return shortcut
    .split("+")
    .map((key) => (key === "Mod" ? (isMac ? "Meta" : "Control") : key))
    .join("+");
}
