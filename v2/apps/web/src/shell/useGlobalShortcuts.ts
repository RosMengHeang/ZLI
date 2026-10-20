import { useEffect, useRef } from "react";

type Handlers = {
  onPalette(): void;
  onNewAgent(): void;
  onQuickOpen(): void;
  onSearchFiles(): void;
  onToggleSidebar(): void;
  onToggleDrawer(): void;
  onEscape(): void;
};

/** The window-wide keyboard shortcuts. Ctrl and Cmd both work so the same keys apply on every platform. */
export function useGlobalShortcuts(handlers: Handlers) {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      const current = ref.current;
      let handler: (() => void) | undefined;
      if (mod && key === "k") handler = current.onPalette;
      else if (mod && key === "n" && !event.shiftKey) handler = current.onNewAgent;
      else if (mod && key === "p" && !event.shiftKey) handler = current.onQuickOpen;
      else if (mod && event.shiftKey && key === "f") handler = current.onSearchFiles;
      else if (mod && key === "b") handler = current.onToggleSidebar;
      else if (mod && key === "j") handler = current.onToggleDrawer;
      else if (event.key === "Escape") {
        current.onEscape();
        return;
      }
      if (!handler) return;
      event.preventDefault();
      handler();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
