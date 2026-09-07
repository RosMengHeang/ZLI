export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /mac/i.test(navigator.platform || navigator.userAgent);
}

export function isModKey(event: KeyboardEvent): boolean {
  return isMacPlatform() ? event.metaKey : event.ctrlKey;
}

export function modShortcutLabel(rest: string): string {
  return `${isMacPlatform() ? "⌘" : "Ctrl"}+${rest}`;
}

export const APP_SHORTCUTS = {
  openProject: modShortcutLabel("Shift+O"),
  addTerminal: modShortcutLabel("Shift+`"),
  addAgent: modShortcutLabel("Shift+A"),
  toggleGit: modShortcutLabel("Shift+G"),
  toggleBrowser: modShortcutLabel("Shift+B"),
};

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return Boolean(target.closest(".xterm, .xterm-helper-textarea"));
}
