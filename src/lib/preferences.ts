import { normalizeThemeMode, type ThemeMode } from "./theme";

const LAST_PROJECT_KEY = "taxzy:last-project-path";
const SETUP_DISMISSED_KEY = "taxzy:setup-dismissed";
const CHROME_LAYOUT_KEY = "taxzy:chrome-layout";
const PANE_LAYOUT_KEY = "taxzy:pane-layout";
export const THEME_MODE_KEY = "taxzy:theme-mode";

export interface ChromeLayout {
  sidebar: number;
  browser: number;
  git: number;
}

export const DEFAULT_CHROME_LAYOUT: ChromeLayout = {
  sidebar: 22,
  browser: 30,
  git: 34,
};

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

export function getLastProjectPath(): string | null {
  const value = read(LAST_PROJECT_KEY)?.trim();
  return value ? value : null;
}

export function setLastProjectPath(path: string): void {
  const trimmed = path.trim();
  if (trimmed) write(LAST_PROJECT_KEY, trimmed);
}

export function wasSetupDismissed(): boolean {
  return read(SETUP_DISMISSED_KEY) === "1";
}

export function setSetupDismissed(dismissed: boolean): void {
  write(SETUP_DISMISSED_KEY, dismissed ? "1" : "0");
}

export function getThemePreference(): ThemeMode {
  return normalizeThemeMode(read(THEME_MODE_KEY));
}

export function setThemePreference(mode: ThemeMode): void {
  write(THEME_MODE_KEY, mode);
}

function readJson<T>(key: string): T | null {
  const raw = read(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function getChromeLayout(): Partial<ChromeLayout> {
  const stored = readJson<Partial<ChromeLayout>>(CHROME_LAYOUT_KEY);
  return {
    sidebar: clampStoredPercentage(stored?.sidebar, 99),
    browser: clampStoredPercentage(stored?.browser, 48),
    git: clampStoredPercentage(stored?.git, 68),
  };
}

export function setChromeLayout(layout: Partial<ChromeLayout>): void {
  write(CHROME_LAYOUT_KEY, JSON.stringify({ ...getChromeLayout(), ...layout }));
}

function clampStoredPercentage(value: unknown, maximum: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(1, value))
    : undefined;
}

export function getPaneLayout(signature: string): number[] | null {
  if (!signature) return null;
  const stored = readJson<PaneLayoutSnapshot>(PANE_LAYOUT_KEY);
  if (!stored || stored.signature !== signature) return null;
  return Array.isArray(stored.sizes) ? stored.sizes : null;
}

export function setPaneLayout(signature: string, sizes: number[]): void {
  if (!signature || sizes.length < 2) return;
  write(PANE_LAYOUT_KEY, JSON.stringify({ signature, sizes } satisfies PaneLayoutSnapshot));
}
