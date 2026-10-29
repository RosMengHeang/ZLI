import {
  type ListedProviderKind,
  type PermissionMode,
  PLAN_LIMIT_PROVIDERS,
  type PlanLimitProvider,
} from "@zli-v2/contracts";
import { useSyncExternalStore } from "react";

import type { SessionMode } from "../sessions/sessions.js";

const STORAGE_KEY = "zli.settings.v1";
export const DEFAULT_BRANCH_TEMPLATE = "{agent}-{random}";
export const MAX_BRANCH_TEMPLATE = 80;

/**
 * Starting choices for the New agent dialog. A missing field means "use the last choice". A model
 * belongs to the agent set next to it, so a model without an agent is ignored.
 */
export type LaunchDefaults = {
  provider?: ListedProviderKind;
  mode?: SessionMode;
  permissionMode?: PermissionMode;
  model?: string;
};

export type ShortcutId =
  | "palette"
  | "newAgent"
  | "newChat"
  | "quickOpen"
  | "searchFiles"
  | "toggleSidebar"
  | "toggleDrawer"
  | "toggleFiles"
  | "toggleBrowser"
  | "toggleMobile"
  | "toggleChanges"
  | "toggleHuddle"
  | "settings";

/** Which side of the Files panel the folder tree sits on when there is room for both. */
export type FileTreePosition = "right" | "left";

/** The plan limits card above Settings. Off until the person turns it on; agents show unless switched off. */
export type SidebarLimits = { enabled: boolean; hidden: PlanLimitProvider[] };

export type AppSettings = {
  defaults: LaunchDefaults;
  /** Per-project overrides, keyed by project id. */
  projects: Record<string, LaunchDefaults>;
  branchTemplate: string;
  /** Only the shortcuts the person changed. */
  shortcuts: Partial<Record<ShortcutId, string>>;
  fileTreePosition: FileTreePosition;
  sidebarLimits: SidebarLimits;
};

export const DEFAULT_SETTINGS: AppSettings = {
  defaults: {},
  projects: {},
  branchTemplate: DEFAULT_BRANCH_TEMPLATE,
  shortcuts: {},
  fileTreePosition: "right",
  sidebarLimits: { enabled: false, hidden: [] },
};

const modes: readonly SessionMode[] = ["terminal", "chat"];
const permissions: readonly PermissionMode[] = ["read-only", "supervised", "full-access"];
const shortcutIds: readonly ShortcutId[] = [
  "palette",
  "newAgent",
  "newChat",
  "quickOpen",
  "searchFiles",
  "toggleSidebar",
  "toggleDrawer",
  "toggleFiles",
  "toggleBrowser",
  "toggleMobile",
  "toggleChanges",
  "toggleHuddle",
  "settings",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDefaults(value: unknown): LaunchDefaults {
  if (!isRecord(value)) return {};
  const provider =
    typeof value.provider === "string" && value.provider ? (value.provider as ListedProviderKind) : undefined;
  const model = provider && typeof value.model === "string" && value.model ? value.model : undefined;
  return {
    ...(provider ? { provider } : {}),
    ...(modes.includes(value.mode as SessionMode) ? { mode: value.mode as SessionMode } : {}),
    ...(permissions.includes(value.permissionMode as PermissionMode)
      ? { permissionMode: value.permissionMode as PermissionMode }
      : {}),
    ...(model ? { model } : {}),
  };
}

function parseSidebarLimits(value: unknown): SidebarLimits {
  if (!isRecord(value)) return { enabled: false, hidden: [] };
  const hidden = Array.isArray(value.hidden)
    ? PLAN_LIMIT_PROVIDERS.filter((provider) => (value.hidden as unknown[]).includes(provider))
    : [];
  return { enabled: value.enabled === true, hidden };
}

export function parseAppSettings(raw: string | null): AppSettings {
  if (!raw) return structuredClone(DEFAULT_SETTINGS);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
  if (!isRecord(value)) return structuredClone(DEFAULT_SETTINGS);
  const projects: Record<string, LaunchDefaults> = {};
  if (isRecord(value.projects)) {
    for (const [projectId, entry] of Object.entries(value.projects)) {
      const parsed = parseDefaults(entry);
      if (Object.keys(parsed).length > 0) projects[projectId] = parsed;
    }
  }
  const shortcuts: Partial<Record<ShortcutId, string>> = {};
  if (isRecord(value.shortcuts)) {
    for (const id of shortcutIds) {
      const shortcut = value.shortcuts[id];
      if (typeof shortcut === "string" && shortcut) shortcuts[id] = shortcut;
    }
  }
  const template =
    typeof value.branchTemplate === "string" && value.branchTemplate.trim()
      ? value.branchTemplate.trim().slice(0, MAX_BRANCH_TEMPLATE)
      : DEFAULT_BRANCH_TEMPLATE;
  return {
    defaults: parseDefaults(value.defaults),
    projects,
    branchTemplate: template,
    shortcuts,
    fileTreePosition: value.fileTreePosition === "left" ? "left" : "right",
    sidebarLimits: parseSidebarLimits(value.sidebarLimits),
  };
}

let cache: AppSettings | undefined;
const listeners = new Set<() => void>();

export function readAppSettings(): AppSettings {
  if (cache) return cache;
  try {
    cache = parseAppSettings(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    cache = structuredClone(DEFAULT_SETTINGS);
  }
  return cache;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    cache = undefined;
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useAppSettings(): AppSettings {
  return useSyncExternalStore(subscribe, readAppSettings, () => DEFAULT_SETTINGS);
}

export function updateAppSettings(change: (current: AppSettings) => AppSettings): AppSettings {
  // Round-tripping through the parser keeps stored settings in the same shape a reload would read.
  const next = parseAppSettings(JSON.stringify(change(readAppSettings())));
  cache = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage can be unavailable; the settings still apply until the window closes.
  }
  for (const listener of listeners) listener();
  return next;
}

/** Project overrides win over the general defaults, which win over the last choice made in the dialog. */
export function resolveLaunchDefaults(
  settings: AppSettings,
  projectId: string | undefined,
  last: LaunchDefaults = {},
): LaunchDefaults {
  const layers = [projectId ? settings.projects[projectId] : undefined, settings.defaults, last].filter(
    (layer): layer is LaunchDefaults => layer !== undefined,
  );
  const providerLayer = layers.find((layer) => layer.provider !== undefined);
  const mode = layers.find((layer) => layer.mode !== undefined)?.mode;
  const permissionMode = layers.find((layer) => layer.permissionMode !== undefined)?.permissionMode;
  return {
    ...(providerLayer?.provider ? { provider: providerLayer.provider } : {}),
    ...(mode ? { mode } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    ...(providerLayer?.model ? { model: providerLayer.model } : {}),
  };
}

const branchStems: Partial<Record<ListedProviderKind, string>> = {
  "claude-code": "claude",
  "cursor-agent": "cursor",
};

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 6).padEnd(4, "0");
}

/** Characters and sequences Git does not allow in a branch name are replaced or dropped. */
function sanitizeBranch(value: string): string {
  return value
    .replace(/\s+/gu, "-")
    .replace(/[~^:?*[\\]/gu, "")
    .split("")
    .filter((character) => character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127)
    .join("")
    .replace(/\.{2,}/gu, ".")
    .replace(/\/{2,}/gu, "/")
    .replace(/@\{/gu, "")
    .split("/")
    .map((part) => part.replace(/^\.+/u, "").replace(/\.lock$/u, ""))
    .filter(Boolean)
    .join("/")
    .replace(/[./-]+$/u, "")
    .replace(/^-+/u, "");
}

/** Fills a branch template such as `{agent}-{random}` or `zli/{date}-{agent}`. */
export function branchFromTemplate(
  template: string,
  provider: ListedProviderKind | undefined,
  now: Date = new Date(),
  random: () => string = randomSuffix,
): string {
  const agent = provider ? (branchStems[provider] ?? provider) : "agent";
  const date = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  const filled = template
    .replaceAll("{agent}", agent)
    .replaceAll("{random}", () => random())
    .replaceAll("{date}", date)
    // Only agents started from an issue fill {issue}; everywhere else it is left out.
    .replaceAll("{issue}", "");
  return sanitizeBranch(filled) || `${agent}-${random()}`;
}
