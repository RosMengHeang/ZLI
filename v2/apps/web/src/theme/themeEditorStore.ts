import { useSyncExternalStore } from "react";

import { readAppSettings, updateAppSettings } from "../settings/appSettings.js";
import { type CustomTheme, MAX_CUSTOM_THEMES } from "./customThemes.js";

/** A theme being made or changed. The app shows the draft while the editor is open. */
export type ThemeEditorSession = {
  draft: CustomTheme;
  /** False when the draft changes a theme that is already saved. */
  isNew: boolean;
  /** Why the last save did not go through; the draft stays open so nothing is lost. */
  error?: string | undefined;
};

/** Shown when there is no room for another theme. */
export const THEME_LIMIT_MESSAGE = `You can keep up to ${MAX_CUSTOM_THEMES} themes. Delete one to make another.`;

let session: ThemeEditorSession | undefined;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function readThemeEditor(): ThemeEditorSession | undefined {
  return session;
}

export function subscribeThemeEditor(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useThemeEditor(): ThemeEditorSession | undefined {
  return useSyncExternalStore(subscribeThemeEditor, readThemeEditor, () => undefined);
}

export function openThemeEditor(draft: CustomTheme, isNew: boolean): void {
  session = { draft: structuredClone(draft), isNew };
  emit();
}

export function updateThemeDraft(change: (draft: CustomTheme) => CustomTheme): void {
  if (!session) return;
  session = { ...session, draft: change(session.draft), error: undefined };
  emit();
}

/** Leaves the editor; the saved theme comes back. */
export function closeThemeEditor(): void {
  session = undefined;
  emit();
}

/**
 * Stores the draft, makes it the current theme, and closes the editor. When there is no room for a new
 * theme, the editor stays open with the draft and says why, rather than dropping the theme.
 */
export function saveThemeEditor(): void {
  if (!session) return;
  const draft = { ...session.draft, name: session.draft.name.trim() || "Untitled theme" };
  const saved = readAppSettings().customThemes;
  if (!saved.some((theme) => theme.id === draft.id) && saved.length >= MAX_CUSTOM_THEMES) {
    session = { ...session, error: THEME_LIMIT_MESSAGE };
    emit();
    return;
  }
  updateAppSettings((current) => {
    const exists = current.customThemes.some((theme) => theme.id === draft.id);
    return {
      ...current,
      theme: draft.id,
      customThemes: exists
        ? current.customThemes.map((theme) => (theme.id === draft.id ? draft : theme))
        : [...current.customThemes, draft],
    };
  });
  closeThemeEditor();
}
