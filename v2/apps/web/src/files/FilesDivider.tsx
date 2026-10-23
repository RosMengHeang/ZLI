import type { KeyboardEvent, PointerEvent } from "react";

const STEP = 16;

/**
 * The splitter between the editor and the file list. Dragging previews the width without
 * re-rendering the pane; the final width is committed when the pointer is released.
 */
export function FilesDivider({
  width,
  min,
  max,
  treeSide,
  controls,
  onPreview,
  onCommit,
  onReset,
}: {
  width: number;
  min: number;
  max: number;
  /** Which side of the divider the file list is on. */
  treeSide: "left" | "right";
  controls: string;
  onPreview(width: number): void;
  onCommit(width: number): void;
  onReset(): void;
}) {
  const clamp = (value: number) => Math.round(Math.min(max, Math.max(min, value)));

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const startX = event.clientX;
    let last = width;
    handle.setPointerCapture?.(event.pointerId);
    handle.classList.add("is-dragging");
    const onMove = (move: globalThis.PointerEvent) => {
      const delta = move.clientX - startX;
      last = clamp(width + (treeSide === "right" ? -delta : delta));
      onPreview(last);
    };
    const onUp = () => {
      handle.classList.remove("is-dragging");
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      if (last !== width) onCommit(last);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const grow = treeSide === "right" ? "ArrowLeft" : "ArrowRight";
    const shrink = treeSide === "right" ? "ArrowRight" : "ArrowLeft";
    let next: number | undefined;
    if (event.key === grow) next = width + STEP;
    else if (event.key === shrink) next = width - STEP;
    else if (event.key === "Home") next = min;
    else if (event.key === "End") next = max;
    if (next === undefined) return;
    event.preventDefault();
    onCommit(clamp(next));
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable ARIA separator is the standard splitter pattern; <hr> cannot take focus or pointer drags.
    <div
      className="files-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize file list"
      aria-controls={controls}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize. Double-click to reset."
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
    />
  );
}
