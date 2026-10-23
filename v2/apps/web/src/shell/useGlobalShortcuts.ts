import { useEffect, useRef } from "react";

import type { ShortcutId } from "../settings/appSettings.js";
import { currentShortcuts, matchesShortcut, shortcutActions } from "./keybindings.js";

type Handlers = Record<ShortcutId, () => void> & { escape(): void };

/**
 * The window-wide keyboard shortcuts, read from Settings on every key press so a change applies at once.
 * Ctrl and Cmd both count as Mod so the same keys work on every platform.
 */
export function useGlobalShortcuts(handlers: Handlers) {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        ref.current.escape();
        return;
      }
      const bindings = currentShortcuts();
      const action = shortcutActions.find((candidate) => matchesShortcut(event, bindings[candidate.id]));
      if (!action) return;
      event.preventDefault();
      ref.current[action.id]();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
