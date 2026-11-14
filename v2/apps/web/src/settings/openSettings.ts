import type { SettingsSection } from "./SettingsDialog.js";

const EVENT = "zli:open-settings";

/**
 * Asks the app shell to open Settings at a section. For controls deep in a chat, such as the model picker,
 * that would otherwise need a callback passed through every layer between them and the shell.
 */
export function requestSettings(section: SettingsSection): void {
  window.dispatchEvent(new CustomEvent<SettingsSection>(EVENT, { detail: section }));
}

/** The shell's side: calls `open` for every request until the returned function is called. */
export function onSettingsRequest(open: (section: SettingsSection) => void): () => void {
  const listener = (event: Event) => {
    const section = (event as CustomEvent<SettingsSection>).detail;
    if (section) open(section);
  };
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
