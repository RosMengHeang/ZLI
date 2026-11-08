import type { Theme } from "@zli-v2/ui/themes";
import { useSyncExternalStore } from "react";

import { getBridge } from "../runtime/bridge.js";
import { readAppSettings, subscribeAppSettings } from "../settings/appSettings.js";
import { buildCustomTheme, resolveTheme } from "./customThemes.js";
import { readThemeEditor, subscribeThemeEditor } from "./themeEditorStore.js";

/** The draft in the theme editor while it is open, otherwise the saved choice. */
export function activeTheme(): Theme {
  const editor = readThemeEditor();
  if (editor) return buildCustomTheme(editor.draft);
  const settings = readAppSettings();
  return resolveTheme(settings.theme, settings.customThemes);
}

const CHROME_DELAY_MS = 150;
let chromeTimer: ReturnType<typeof setTimeout> | undefined;

/** The desktop window frame sits outside the page; dragging a color updates it once the drag settles. */
function updateChrome(theme: Theme): void {
  const setChrome = getBridge()?.app.setChrome;
  if (!setChrome) return;
  clearTimeout(chromeTimer);
  chromeTimer = setTimeout(() => {
    void setChrome({
      background: theme.tokens["--zli-canvas"] ?? "",
      symbols: theme.tokens["--zli-muted"] ?? "",
    }).catch(() => undefined);
  }, CHROME_DELAY_MS);
}

/** Sets every color token of the theme on the root element, so all styles follow it at once. */
export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  for (const [property, value] of Object.entries(theme.tokens)) root.style.setProperty(property, value);
  root.dataset.theme = theme.id;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme.tokens["--zli-canvas"] ?? "");
  updateChrome(theme);
}

let current: Theme | undefined;
const listeners = new Set<() => void>();

function readCurrent(): Theme {
  current ??= activeTheme();
  return current;
}

function subscribeCurrent(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The theme on screen, for code that draws colors outside CSS, such as the terminal. */
export function useActiveTheme(): Theme {
  return useSyncExternalStore(subscribeCurrent, readCurrent, readCurrent);
}

function refresh(): void {
  const next = activeTheme();
  if (current && current.id === next.id && JSON.stringify(current.base) === JSON.stringify(next.base)) return;
  current = next;
  applyTheme(next);
  for (const listener of listeners) listener();
}

/** Applies the theme now and again whenever the saved choice or the editor's draft changes. */
export function startTheme(): () => void {
  current = undefined;
  refresh();
  const stopSettings = subscribeAppSettings(refresh);
  const stopEditor = subscribeThemeEditor(refresh);
  return () => {
    stopSettings();
    stopEditor();
  };
}
