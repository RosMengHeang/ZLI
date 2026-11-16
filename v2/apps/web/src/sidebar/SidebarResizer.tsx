import type { KeyboardEvent, PointerEvent } from "react";
import { useState } from "react";

const STORAGE_KEY = "zli.sidebarWidth";
export const MIN_SIDEBAR_WIDTH = 200;
export const MAX_SIDEBAR_WIDTH = 420;
const STEP = 16;

/** The widest the sidebar may be: its own limit, and never more than 40% of the window. */
function maxWidth(): number {
  const share = typeof window === "undefined" ? MAX_SIDEBAR_WIDTH : Math.round(window.innerWidth * 0.4);
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, share));
}

export function clampSidebarWidth(width: number): number {
  return Math.min(maxWidth(), Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)));
}

function storedWidth(): number | undefined {
  try {
    const stored = Number(window.localStorage.getItem(STORAGE_KEY));
    return stored > 0 ? clampSidebarWidth(stored) : undefined;
  } catch {
    return undefined;
  }
}

/** The width the person dragged the sidebar to, or undefined for the default that follows the window size. */
export function useSidebarWidth(): [number | undefined, (width: number | undefined) => void] {
  const [width, setWidth] = useState<number | undefined>(storedWidth);
  const update = (next: number | undefined) => {
    const clamped = next === undefined ? undefined : clampSidebarWidth(next);
    setWidth(clamped);
    try {
      if (clamped === undefined) window.localStorage.removeItem(STORAGE_KEY);
      else window.localStorage.setItem(STORAGE_KEY, String(clamped));
    } catch {
      // Storage can be unavailable; the width still applies for this session.
    }
  };
  return [width, update];
}

/** The sidebar's right edge. Drag or use the arrow keys to resize; double-click goes back to the default. */
export function SidebarResizer({
  width,
  onChange,
}: {
  /** The dragged width, or undefined while the sidebar keeps its default. */
  width: number | undefined;
  onChange(width: number | undefined): void;
}) {
  const current = () => document.querySelector(".sidebar")?.getBoundingClientRect().width ?? 256;
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = current();
    handle.setPointerCapture(event.pointerId);
    handle.classList.add("is-dragging");
    document.body.classList.add("is-resizing-sidebar");
    const onMove = (move: globalThis.PointerEvent) => onChange(startWidth + (move.clientX - startX));
    const onUp = () => {
      handle.classList.remove("is-dragging");
      document.body.classList.remove("is-resizing-sidebar");
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowRight") onChange(current() + STEP);
    else if (event.key === "ArrowLeft") onChange(current() - STEP);
    else return;
    event.preventDefault();
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable ARIA separator is the standard splitter pattern; <hr> cannot take focus or pointer drags.
    <div
      className="sidebar-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={MIN_SIDEBAR_WIDTH}
      aria-valuemax={maxWidth()}
      aria-valuenow={width ?? 256}
      tabIndex={0}
      title="Drag to resize. Double-click to reset."
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onChange(undefined)}
    />
  );
}
