const LAST_PROJECT_KEY = "taxzy:last-project-path";
const SETUP_DISMISSED_KEY = "taxzy:setup-dismissed";
const CHROME_LAYOUT_KEY = "taxzy:chrome-layout";
const PANE_LAYOUT_KEY = "taxzy:pane-layout";

export interface ChromeLayout {
  sidebar: number;
  browser: number;
  git: number;
}

export const DEFAULT_CHROME_LAYOUT: ChromeLayout = {
  sidebar: 22,
  browser: 32,
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

function readJson<T>(key: string): T | null {
  const raw = read(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function getChromeLayout(): ChromeLayout {
  const stored = readJson<Partial<ChromeLayout>>(CHROME_LAYOUT_KEY);
  return {
    sidebar: stored?.sidebar ?? DEFAULT_CHROME_LAYOUT.sidebar,
    browser: stored?.browser ?? DEFAULT_CHROME_LAYOUT.browser,
    git: stored?.git ?? DEFAULT_CHROME_LAYOUT.git,
  };
}

export function setChromeLayout(layout: ChromeLayout): void {
  write(CHROME_LAYOUT_KEY, JSON.stringify(layout));
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
