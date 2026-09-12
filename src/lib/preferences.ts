import { normalizeThemeMode, type ThemeMode } from "./theme.ts";
import { SHELL_LIMITS } from "./chromePresentation.ts";

const PREF_PREFIX = "zli:";
const LEGACY_PREF_PREFIX = "taxzy:";

const LAST_PROJECT_SUFFIX = "last-project-path";
const SETUP_DISMISSED_SUFFIX = "setup-dismissed";
const CHROME_LAYOUT_SUFFIX = "chrome-layout";
const PANE_LAYOUT_SUFFIX = "pane-layout";
const THEME_MODE_SUFFIX = "theme-mode";
export const WORKSPACE_REGISTRY_SUFFIX = "workspace-registry";
export const BROWSER_PERMISSIONS_SUFFIX = "browser-permissions";

export const THEME_MODE_KEY = `${PREF_PREFIX}${THEME_MODE_SUFFIX}`;

export interface ChromeLayout {
  sidebar: number;
  browser: number;
  git: number;
}

export const DEFAULT_CHROME_LAYOUT = {
  sidebar: SHELL_LIMITS.sidebar.default,
  browser: SHELL_LIMITS.browser.default,
  git: SHELL_LIMITS.git.default,
} as const;

interface PaneLayoutSnapshot {
  signature: string;
  sizes: number[];
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode / quota */
  }
}

function remove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* private mode */
  }
}

/** Dual-read `zli:*`, copying from `taxzy:*` once when the new key is absent. */
export function readPref(suffix: string): string | null {
  const key = `${PREF_PREFIX}${suffix}`;
  const legacyKey = `${LEGACY_PREF_PREFIX}${suffix}`;
  const current = read(key);
  if (current !== null) return current;
  const legacy = read(legacyKey);
  if (legacy === null) return null;
  write(key, legacy);
  remove(legacyKey);
  return legacy;
}

export function writePref(suffix: string, value: string): void {
  write(`${PREF_PREFIX}${suffix}`, value);
  remove(`${LEGACY_PREF_PREFIX}${suffix}`);
}

export function getLastProjectPath(): string | null {
  const value = readPref(LAST_PROJECT_SUFFIX)?.trim();
  return value ? value : null;
}

export function setLastProjectPath(path: string): void {
  const trimmed = path.trim();
  if (trimmed) writePref(LAST_PROJECT_SUFFIX, trimmed);
}

export function wasSetupDismissed(): boolean {
  return readPref(SETUP_DISMISSED_SUFFIX) === "1";
}

export function setSetupDismissed(dismissed: boolean): void {
  writePref(SETUP_DISMISSED_SUFFIX, dismissed ? "1" : "0");
}

export function getThemePreference(): ThemeMode {
  return normalizeThemeMode(readPref(THEME_MODE_SUFFIX));
}

export function setThemePreference(mode: ThemeMode): void {
  writePref(THEME_MODE_SUFFIX, mode);
}

function readJson<T>(suffix: string): T | null {
  const raw = readPref(suffix);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function getChromeLayout(): Partial<ChromeLayout> {
  const stored = readJson<Partial<ChromeLayout>>(CHROME_LAYOUT_SUFFIX);
  return {
    sidebar: clampStoredPercentage(stored?.sidebar, 99),
    browser: clampStoredPercentage(stored?.browser, 48),
    git: clampStoredPercentage(stored?.git, 68),
  };
}

export function setChromeLayout(layout: Partial<ChromeLayout>): void {
  writePref(CHROME_LAYOUT_SUFFIX, JSON.stringify({ ...getChromeLayout(), ...layout }));
}

function clampStoredPercentage(value: unknown, maximum: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(1, value))
    : undefined;
}

export function getPaneLayout(signature: string): number[] | null {
  if (!signature) return null;
  const stored = readJson<PaneLayoutSnapshot>(PANE_LAYOUT_SUFFIX);
  if (!stored || stored.signature !== signature) return null;
  return Array.isArray(stored.sizes) ? stored.sizes : null;
}

export function setPaneLayout(signature: string, sizes: number[]): void {
  if (!signature || sizes.length < 2) return;
  writePref(PANE_LAYOUT_SUFFIX, JSON.stringify({ signature, sizes } satisfies PaneLayoutSnapshot));
}
