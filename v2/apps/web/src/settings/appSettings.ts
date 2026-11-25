import {
  type ListedProviderKind,
  type PermissionMode,
  PLAN_LIMIT_PROVIDERS,
  type PlanLimitProvider,
} from "@zli-v2/contracts";
import { isThemeId } from "@zli-v2/ui/themes";
import { useSyncExternalStore } from "react";
import {
  type BackdropStyle,
  clampIntensity,
  DEFAULT_BACKDROP_INTENSITY,
  DEFAULT_BACKDROP_STYLE,
  DEFAULT_IMAGE_EFFECT,
  type ImageEffect,
  isBackdropStyle,
  isImageEffect,
  normalizeHex,
} from "../chat/backdrop.js";
import { DEFAULT_AUTO_COMPACT_AT } from "../chat/compaction.js";
import type { SessionMode } from "../sessions/sessions.js";
import { parseTeammates, type Teammate } from "../teammates/teammates.js";
import { type CustomTheme, parseCustomThemes, SYSTEM_THEME } from "../theme/customThemes.js";
import { DEFAULT_TYPOGRAPHY, parseTypography, type Typography } from "../theme/typography.js";

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
  /** With the chat view, also opens the terminal drawer so a shell sits under the chat. */
  withTerminal?: boolean;
};

/** The three ways the person can like to work, as Settings and the welcome flow show them. */
export type WorkStyle = "chat" | "terminal" | "chat-terminal";

export function workStyleOf(defaults: Pick<LaunchDefaults, "mode" | "withTerminal">): WorkStyle | undefined {
  if (defaults.mode === "chat") return defaults.withTerminal ? "chat-terminal" : "chat";
  return defaults.mode;
}

export function withWorkStyle<T extends LaunchDefaults>(defaults: T, style: WorkStyle | undefined): T {
  const { mode: _mode, withTerminal: _withTerminal, ...rest } = defaults;
  if (!style) return rest as T;
  if (style === "terminal") return { ...rest, mode: "terminal" } as T;
  return { ...rest, mode: "chat", ...(style === "chat-terminal" ? { withTerminal: true } : {}) } as T;
}

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
  | "focusProject"
  | "sideQuestion"
  | "settings";

/** Which side of the Files panel the folder tree sits on when there is room for both. */
export type FileTreePosition = "right" | "left";

/**
 * The plan limits line in the sidebar footer. Off until the person turns it on; agents show unless
 * switched off. `pinned` is the agent the folded line always shows; without it, the line follows the
 * selected agent.
 */
export type SidebarLimits = { enabled: boolean; hidden: PlanLimitProvider[]; pinned?: PlanLimitProvider };

export type AppSettings = {
  defaults: LaunchDefaults;
  /** Per-project overrides, keyed by project id. */
  projects: Record<string, LaunchDefaults>;
  branchTemplate: string;
  /** How new worktrees are made and cleaned up. */
  worktrees: WorktreePrefs;
  /** Only the shortcuts the person changed. */
  shortcuts: Partial<Record<ShortcutId, string>>;
  fileTreePosition: FileTreePosition;
  sidebarLimits: SidebarLimits;
  /** When the person finished or skipped the welcome flow. Unset shows it on a fresh install. */
  onboardedAt?: string;
  /** The color theme of every ZLI window: "system", a built-in theme id, or the id of one in customThemes. */
  theme: string;
  /** Themes the person made in the theme editor. */
  customThemes: CustomTheme[];
  /** Teammates saved before buddies replaced them. Read once, turned into buddies, then cleared. */
  teammates: Teammate[];
  /** The buddy avatars move while their agent works. Off keeps them still. */
  animateTeammates: boolean;
  /** Each project heading in the sidebar takes a soft tint of its lantern colour. Off keeps headings plain. */
  tintProjects: boolean;
  /** How the chats under a project take its colour: a faint card around the project, only the open and pointed-at chat, or not at all. */
  chatTint: ChatTint;
  /** A chat moves to Archived once its branch's pull request merges or closes. */
  archiveMergedChats: boolean;
  /** Several chats share the screen side by side. Off shows one at a time, switched from the sidebar. */
  severalChats: boolean;
  /** Columns: each column carries its own header on one row, no top bar. Classic: a top bar over separate panels. */
  layout: WindowLayout;
  /** The person chose the layout. Before Classic became the default, Columns was saved for everyone who never chose. */
  layoutChosen?: true;
  /** Chats in the sidebar take one line, title and time, unless they are working, waiting on you, or failed. */
  compactChats: boolean;
  /** The sidebar lists chats by when they last moved (activity) or under their projects. */
  sidebarView: SidebarView;
  /** The sidebar's background and its row height. The window layout decides whether it floats in a box. */
  sidebarLook: SidebarLook;
  /** Text sizes and fonts, from Settings > Appearance. */
  typography: Typography;
  /** The background behind every chat, in the theme's accent, and how strongly it shows (0 to 100). */
  chatBackdrop: ChatBackdrop;
  /** Agents pinned to the front of the model menu, as "provider:accountId". */
  pinnedAgents: string[];
  /** Models pinned to the top of their agent's list, as "provider:model". */
  pinnedModels: string[];
  /** Compact a chat by itself once a finished turn leaves its context at least `at` full (0 to 1). */
  autoCompact: AutoCompact;
};

export type AutoCompact = { enabled: boolean; at: number };

/**
 * `background`: the theme's own sidebar color, the same color as the chats, or a tint. A tint mixes `color`
 * (the theme's accent when unset) into the theme's sidebar at `strength` percent, so text stays readable.
 */
export type SidebarLook = {
  background: SidebarBackground;
  color?: string;
  strength: number;
  density: SidebarDensity;
};
export type SidebarBackground = "theme" | "surface" | "tint";
export type SidebarDensity = "comfortable" | "compact";
export const SIDEBAR_TINT_MIN = 4;
export const SIDEBAR_TINT_MAX = 40;
export const DEFAULT_SIDEBAR_LOOK: SidebarLook = {
  background: "theme",
  strength: 12,
  density: "comfortable",
};

/**
 * `color` is a `#rrggbb` the person picked; without it the background takes the theme's accent.
 * `imageEffect` is how their own picture is shown when the style is "image".
 */
export type ChatBackdrop = {
  style: BackdropStyle;
  intensity: number;
  color?: string;
  imageEffect: ImageEffect;
};

export type WindowLayout = "columns" | "classic";
export type SidebarView = "activity" | "projects";
export type ChatTint = "card" | "selection" | "none";

export type WorktreePrefs = {
  /** A folder that holds every project's worktrees, one subfolder per project. Unset: next to each project. */
  location?: string;
  /** Fetch the base branch first and start from its remote copy. */
  fromRemote: boolean;
  /** Deleting an agent offers to remove its worktree too, ticked from the start. */
  removeWithAgent: boolean;
};

export const DEFAULT_WORKTREE_PREFS: WorktreePrefs = { fromRemote: false, removeWithAgent: false };

export function parseWorktreePrefs(value: unknown): WorktreePrefs {
  if (!isRecord(value)) return { ...DEFAULT_WORKTREE_PREFS };
  const location = typeof value.location === "string" ? value.location.trim().slice(0, 500) : "";
  return {
    ...(location ? { location } : {}),
    fromRemote: value.fromRemote === true,
    removeWithAgent: value.removeWithAgent === true,
  };
}

export const DEFAULT_SETTINGS: AppSettings = {
  defaults: {},
  projects: {},
  branchTemplate: DEFAULT_BRANCH_TEMPLATE,
  worktrees: DEFAULT_WORKTREE_PREFS,
  shortcuts: {},
  fileTreePosition: "right",
  sidebarLimits: { enabled: true, hidden: [] },
  pinnedAgents: [],
  pinnedModels: [],
  autoCompact: { enabled: true, at: DEFAULT_AUTO_COMPACT_AT },
  theme: SYSTEM_THEME,
  customThemes: [],
  teammates: [],
  animateTeammates: true,
  tintProjects: true,
  chatTint: "card",
  archiveMergedChats: true,
  severalChats: false,
  layout: "classic",
  compactChats: true,
  sidebarView: "activity",
  sidebarLook: DEFAULT_SIDEBAR_LOOK,
  typography: DEFAULT_TYPOGRAPHY,
  chatBackdrop: {
    style: DEFAULT_BACKDROP_STYLE,
    intensity: DEFAULT_BACKDROP_INTENSITY,
    imageEffect: DEFAULT_IMAGE_EFFECT,
  },
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
  "focusProject",
  "sideQuestion",
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
    ...(value.mode === "chat" && value.withTerminal === true ? { withTerminal: true } : {}),
  };
}

function parseSidebarLimits(value: unknown): SidebarLimits {
  if (!isRecord(value)) return { enabled: true, hidden: [] };
  const hidden = Array.isArray(value.hidden)
    ? PLAN_LIMIT_PROVIDERS.filter((provider) => (value.hidden as unknown[]).includes(provider))
    : [];
  const pinned = PLAN_LIMIT_PROVIDERS.find((provider) => provider === value.pinned);
  return { enabled: value.enabled !== false, hidden, ...(pinned ? { pinned } : {}) };
}

function parseChatBackdrop(value: unknown): ChatBackdrop {
  if (!isRecord(value)) return structuredClone(DEFAULT_SETTINGS.chatBackdrop);
  const color = normalizeHex(value.color);
  return {
    style: isBackdropStyle(value.style) ? value.style : DEFAULT_BACKDROP_STYLE,
    intensity: clampIntensity(value.intensity),
    ...(color ? { color } : {}),
    imageEffect: isImageEffect(value.imageEffect) ? value.imageEffect : DEFAULT_IMAGE_EFFECT,
  };
}

function knownTheme(value: unknown, customThemes: readonly CustomTheme[]): value is string {
  return value === SYSTEM_THEME || isThemeId(value) || customThemes.some((theme) => theme.id === value);
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
  const customThemes = parseCustomThemes(value.customThemes);
  return {
    defaults: parseDefaults(value.defaults),
    projects,
    branchTemplate: template,
    worktrees: parseWorktreePrefs(value.worktrees),
    shortcuts,
    fileTreePosition: value.fileTreePosition === "left" ? "left" : "right",
    sidebarLimits: parseSidebarLimits(value.sidebarLimits),
    ...(typeof value.onboardedAt === "string" && value.onboardedAt ? { onboardedAt: value.onboardedAt } : {}),
    theme: knownTheme(value.theme, customThemes) ? value.theme : SYSTEM_THEME,
    customThemes,
    teammates: parseTeammates(value.teammates),
    animateTeammates: value.animateTeammates !== false,
    tintProjects: value.tintProjects !== false,
    chatTint: value.chatTint === "selection" || value.chatTint === "none" ? value.chatTint : "card",
    archiveMergedChats: value.archiveMergedChats !== false,
    severalChats: value.severalChats === true,
    // Rounded panels are the default; Columns stays for whoever picked it.
    layout: value.layoutChosen === true && value.layout === "columns" ? "columns" : "classic",
    ...(value.layoutChosen === true ? { layoutChosen: true as const } : {}),
    compactChats: value.compactChats !== false,
    sidebarView: value.sidebarView === "projects" ? "projects" : "activity",
    sidebarLook: parseSidebarLook(value.sidebarLook),
    typography: parseTypography(value.typography),
    chatBackdrop: parseChatBackdrop(value.chatBackdrop),
    pinnedAgents: parsePins(value.pinnedAgents),
    pinnedModels: parsePins(value.pinnedModels),
    autoCompact: parseAutoCompact(value.autoCompact),
  };
}

export function parseSidebarLook(value: unknown): SidebarLook {
  const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const background: SidebarBackground =
    record.background === "surface" || record.background === "tint" ? record.background : "theme";
  const strength =
    typeof record.strength === "number" && Number.isFinite(record.strength)
      ? Math.round(Math.min(SIDEBAR_TINT_MAX, Math.max(SIDEBAR_TINT_MIN, record.strength)))
      : DEFAULT_SIDEBAR_LOOK.strength;
  const color =
    typeof record.color === "string" && /^#[0-9a-f]{6}$/iu.test(record.color) ? record.color.toLowerCase() : undefined;
  return {
    background,
    ...(color ? { color } : {}),
    strength,
    density: record.density === "compact" ? "compact" : "comfortable",
  };
}

function parseAutoCompact(value: unknown): AutoCompact {
  const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const at =
    typeof record.at === "number" && record.at >= 0.5 && record.at <= 0.95 ? record.at : DEFAULT_AUTO_COMPACT_AT;
  return { enabled: record.enabled !== false, at };
}

/** Pins are short "provider:id" keys; anything else, and any past the first fifty, is dropped. */
function parsePins(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const pins = value.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0 && entry.length <= 200,
  );
  return [...new Set(pins)].slice(0, 50);
}

/** Pins `key` when it is not pinned, and unpins it when it is. */
export function togglePin(pins: readonly string[], key: string): string[] {
  return pins.includes(key) ? pins.filter((pin) => pin !== key) : [...pins, key];
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

/** Calls `listener` whenever the settings change, in this window or another one. */
export function subscribeAppSettings(listener: () => void): () => void {
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
  return useSyncExternalStore(subscribeAppSettings, readAppSettings, () => DEFAULT_SETTINGS);
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
  // The terminal drawer belongs to the layer that chose the view, so a project's Chat is not widened.
  const modeLayer = layers.find((layer) => layer.mode !== undefined);
  const mode = modeLayer?.mode;
  const permissionMode = layers.find((layer) => layer.permissionMode !== undefined)?.permissionMode;
  return {
    ...(providerLayer?.provider ? { provider: providerLayer.provider } : {}),
    ...(mode ? { mode } : {}),
    ...(mode === "chat" && modeLayer?.withTerminal ? { withTerminal: true } : {}),
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
