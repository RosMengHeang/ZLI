import type { KeyboardEvent, PointerEvent } from "react";
import { useState } from "react";

const STORAGE_KEY = "zli.toolPanelWidth";
const MIN_WIDTH = 320;
const DEFAULT_WIDTH = 460;
const STEP = 24;

function maxWidth(): number {
  return typeof window === "undefined" ? 1200 : Math.max(MIN_WIDTH, Math.round(window.innerWidth * 0.65));
}

export function clampPanelWidth(width: number): number {
  return Math.min(maxWidth(), Math.max(MIN_WIDTH, Math.round(width)));
}

export function usePanelWidth(): [number, (width: number) => void] {
  const [width, setWidth] = useState(() => {
    try {
      const stored = Number(window.localStorage.getItem(STORAGE_KEY));
      return stored > 0 ? clampPanelWidth(stored) : DEFAULT_WIDTH;
    } catch {
      return DEFAULT_WIDTH;
    }
  });
  const update = (next: number) => {
    const clamped = clampPanelWidth(next);
    setWidth(clamped);
    try {
      window.localStorage.setItem(STORAGE_KEY, String(clamped));
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
