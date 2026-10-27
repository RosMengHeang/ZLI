import type { ShortcutId } from "../settings/appSettings.js";
import { readAppSettings, useAppSettings } from "../settings/appSettings.js";

export type ShortcutAction = { id: ShortcutId; label: string; shortcut: string };

/** The window-wide shortcuts a person can change, in the order Settings and Help list them. */
export const shortcutActions: readonly ShortcutAction[] = [
  { id: "palette", label: "Command palette", shortcut: "Mod+K" },
  { id: "newAgent", label: "New agent", shortcut: "Mod+N" },
  { id: "newChat", label: "New chat in the focused agent", shortcut: "Mod+Shift+O" },
  { id: "quickOpen", label: "Go to file", shortcut: "Mod+P" },
  { id: "searchFiles", label: "Search in files", shortcut: "Mod+Shift+F" },
  { id: "toggleSidebar", label: "Show or hide the sidebar", shortcut: "Mod+B" },
  { id: "toggleDrawer", label: "Show or hide the terminal", shortcut: "Mod+J" },
  { id: "toggleFiles", label: "Show or hide files", shortcut: "Mod+Shift+E" },
  { id: "toggleBrowser", label: "Show or hide the browser", shortcut: "Mod+Shift+B" },
  { id: "toggleMobile", label: "Show or hide the mobile panel", shortcut: "Mod+Shift+M" },
  { id: "toggleChanges", label: "Show or hide changes", shortcut: "Mod+Shift+G" },
  { id: "settings", label: "Settings", shortcut: "Mod+," },
];

/** Editing and clipboard keys that text fields, the terminal, and the editor rely on. */
const reserved = new Map<string, string>([
  ["Mod+A", "select all"],
  ["Mod+C", "copy"],
  ["Mod+V", "paste"],
  ["Mod+X", "cut"],
  ["Mod+Z", "undo"],
  ["Mod+Shift+Z", "redo"],
  ["Mod+Y", "redo"],
  ["Mod+S", "saving files"],
  ["Mod+L", "asking an agent about code"],
  ["Mod+F", "find"],
  ["Mod+Enter", "sending"],
]);

const codeKeys: Record<string, string> = {
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  Space: "Space",
  Enter: "Enter",
  Backspace: "Backspace",
  Delete: "Delete",
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
};

type KeyInput = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">;

/** The pressed key as a single key cap name, or undefined for a lone modifier or an unknown key. */
function keyName(event: KeyInput): string | undefined {
  // Letters follow the keyboard layout; other keys use their physical position so Shift does not change them.
  if (/^[a-z]$/iu.test(event.key)) return event.key.toUpperCase();
  if (/^Key[A-Z]$/u.test(event.code)) return event.code.slice(3);
  if (/^Digit\d$/u.test(event.code)) return event.code.slice(5);
  if (/^F\d{1,2}$/u.test(event.code)) return event.code;
  return codeKeys[event.code];
}

/** A keydown event written the way shortcuts are stored, for example "Mod+Shift+F". */
export function shortcutFromEvent(event: KeyInput): string | undefined {
  const key = keyName(event);
  if (!key) return undefined;
  const parts = [
    ...(event.ctrlKey || event.metaKey ? ["Mod"] : []),
    ...(event.altKey ? ["Alt"] : []),
    ...(event.shiftKey ? ["Shift"] : []),
    key,
  ];
  return parts.join("+");
}

export function matchesShortcut(event: KeyInput, shortcut: string): boolean {
  return shortcut !== "" && shortcutFromEvent(event) === shortcut;
}

export function resolveShortcuts(overrides: Partial<Record<ShortcutId, string>>): Record<ShortcutId, string> {
  return Object.fromEntries(
    shortcutActions.map((action) => [action.id, overrides[action.id] ?? action.shortcut]),
  ) as Record<ShortcutId, string>;
}

/** Why a recorded shortcut cannot be used for `id`, or undefined when it can. */
export function shortcutProblem(
  overrides: Partial<Record<ShortcutId, string>>,
  id: ShortcutId,
  shortcut: string,
): string | undefined {
  const parts = shortcut.split("+");
  if (!parts.includes("Mod") && !parts.includes("Alt") && !/^F\d{1,2}$/u.test(parts.at(-1) ?? "")) {
    return "Include Ctrl, Cmd, or Alt so typing is not interrupted.";
  }
  const kept = reserved.get(shortcut);
  if (kept) return `This key is kept for ${kept}.`;
  const bindings = resolveShortcuts(overrides);
  const taken = shortcutActions.find((action) => action.id !== id && bindings[action.id] === shortcut);
  return taken ? `Already used by ${taken.label}.` : undefined;
}

export function useShortcut(id: ShortcutId): string {
  const settings = useAppSettings();
  return settings.shortcuts[id] ?? defaultShortcut(id);
}

export function useShortcuts(): Record<ShortcutId, string> {
  return resolveShortcuts(useAppSettings().shortcuts);
}

export function currentShortcuts(): Record<ShortcutId, string> {
  return resolveShortcuts(readAppSettings().shortcuts);
}

export function defaultShortcut(id: ShortcutId): string {
  return shortcutActions.find((action) => action.id === id)?.shortcut ?? "";
}
