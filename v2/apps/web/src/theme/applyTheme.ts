import { THEMES, type ThemeId } from "@zli-v2/ui/themes";

import { getBridge } from "../runtime/bridge.js";
import { readAppSettings, subscribeAppSettings } from "../settings/appSettings.js";

/** Sets every color token of the theme on the root element, so all styles follow it at once. */
export function applyTheme(id: ThemeId, root: HTMLElement = document.documentElement): void {
  const theme = THEMES[id];
  for (const [property, value] of Object.entries(theme.tokens)) root.style.setProperty(property, value);
  root.dataset.theme = id;
  const canvas = theme.tokens["--zli-canvas"] ?? "";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", canvas);
  // The desktop window frame and its native controls sit outside the page.
  void getBridge()
    ?.app.setChrome?.({ background: canvas, symbols: theme.tokens["--zli-muted"] ?? "" })
    .catch(() => undefined);
}

/** Applies the saved theme now and again whenever it changes, here or in another window. */
export function startTheme(): () => void {
  let current = readAppSettings().theme;
  applyTheme(current);
  return subscribeAppSettings(() => {
    const next = readAppSettings().theme;
    if (next === current) return;
    current = next;
    applyTheme(next);
  });
}
