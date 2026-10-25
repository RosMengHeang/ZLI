import type { KeyboardEvent, PointerEvent } from "react";
import { useState } from "react";

export type PanelId = "files" | "review" | "browser" | "mobile";

const STORAGE_PREFIX = "zli.toolPanelWidth.";
const MIN_WIDTH = 320;
const STEP = 24;
/** Files needs room for the tree beside the editor; the others read fine narrower. */
const DEFAULT_WIDTHS: Record<PanelId, number> = { files: 640, browser: 560, mobile: 440, review: 520 };
const DEFAULT_SHARE = 0.45;

function maxWidth(): number {
  return typeof window === "undefined" ? 1200 : Math.max(MIN_WIDTH, Math.round(window.innerWidth * 0.65));
}

export function clampPanelWidth(width: number): number {
  return Math.min(maxWidth(), Math.max(MIN_WIDTH, Math.round(width)));
}

/** The width a panel opens at before anyone resizes it, leaving most of a small window to the agents. */
export function defaultPanelWidth(panel: PanelId): number {
  const share = typeof window === "undefined" ? Number.POSITIVE_INFINITY : window.innerWidth * DEFAULT_SHARE;
  return clampPanelWidth(Math.min(DEFAULT_WIDTHS[panel], share));
}

function storedWidth(panel: PanelId): number {
  try {
    const stored = Number(window.localStorage.getItem(STORAGE_PREFIX + panel));
    return stored > 0 ? clampPanelWidth(stored) : defaultPanelWidth(panel);
  } catch {
    return defaultPanelWidth(panel);
  }
}

/** Each side panel keeps its own width. */
export function usePanelWidth(panel: PanelId): [number, (width: number) => void] {
  const [widths, setWidths] = useState<Partial<Record<PanelId, number>>>({});
  const width = widths[panel] ?? storedWidth(panel);
  const update = (next: number) => {
    const clamped = clampPanelWidth(next);
    setWidths((current) => ({ ...current, [panel]: clamped }));
    try {
      window.localStorage.setItem(STORAGE_PREFIX + panel, String(clamped));
    } catch {
      // Storage can be unavailable; the width still applies for this session.
    }
  };
  return [width, update];
}
export function PanelResizer({ width, onChange }: { width: number; onChange(width: number): void }) {
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = width;
    handle.setPointerCapture(event.pointerId);
    handle.classList.add("is-dragging");
    const onMove = (move: globalThis.PointerEvent) => onChange(startWidth + (startX - move.clientX));
    const onUp = () => {
      handle.classList.remove("is-dragging");
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") onChange(width + STEP);
    else if (event.key === "ArrowRight") onChange(width - STEP);
    else return;
    event.preventDefault();
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable ARIA separator is the standard splitter pattern; <hr> cannot take focus or pointer drags.
    <div
      className="panel-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize side panel"
      aria-valuemin={MIN_WIDTH}
      aria-valuemax={maxWidth()}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  );
}
