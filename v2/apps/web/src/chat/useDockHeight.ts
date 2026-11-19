import { type RefObject, useLayoutEffect } from "react";

/**
 * The message box floats over the end of a chat, so the chat scrolls on under it. This writes the box's height
 * to `--dock-h` on the view, which the log uses as room at its end, and keeps a log that was at its end there
 * when the box grows or shrinks.
 */
export function useDockHeight(
  view: RefObject<HTMLElement | null>,
  dock: RefObject<HTMLElement | null>,
  log: RefObject<HTMLElement | null>,
) {
  useLayoutEffect(() => {
    const viewElement = view.current;
    const dockElement = dock.current;
    if (!viewElement || !dockElement) return;
    let last = 0;
    const measure = () => {
      const height = Math.ceil(dockElement.getBoundingClientRect().height);
      if (height === last) return;
      const logElement = log.current;
      const fromEnd = logElement ? logElement.scrollHeight - logElement.scrollTop - logElement.clientHeight : 0;
      viewElement.style.setProperty("--dock-h", `${height}px`);
      // The log was at its end before the room changed: keep it there.
      if (logElement && fromEnd < 48) logElement.scrollTop = logElement.scrollHeight;
      last = height;
    };
    measure();
    // Without a way to watch the size, as in tests, the room is set once.
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(dockElement);
    return () => observer.disconnect();
  }, [view, dock, log]);
}
