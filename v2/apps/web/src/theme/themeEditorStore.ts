import { useSyncExternalStore } from "react";

import { updateAppSettings } from "../settings/appSettings.js";
import type { CustomTheme } from "./customThemes.js";

/** A theme being made or changed. The app shows the draft while the editor is open. */
export type ThemeEditorSession = {
  draft: CustomTheme;
  /** False when the draft changes a theme that is already saved. */
  isNew: boolean;
};

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
  session = { ...session, draft: change(session.draft) };
  emit();
}

/** Leaves the editor; the saved theme comes back. */
export function closeThemeEditor(): void {
  session = undefined;
  emit();
}

/** Stores the draft, makes it the current theme, and closes the editor. */
export function saveThemeEditor(): void {
  if (!session) return;
  const draft = { ...session.draft, name: session.draft.name.trim() || "Untitled theme" };
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
