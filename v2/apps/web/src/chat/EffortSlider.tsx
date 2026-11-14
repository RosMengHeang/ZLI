import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { scrollMovesAnchor, useAnchoredPlacement } from "../ui/anchoredPopup.js";
import { Icon } from "../ui/Icon.js";
import { EffortDial } from "./ReasoningMeter.js";
import { ReasoningTrack } from "./ReasoningTrack.js";
import { reasoningHint, reasoningLabel } from "./reasoning.js";

/**
 * Effort as a slider: the levels are ticks on one track from least to most thinking, filled up to the knob.
 * Dragging lifts a label out of the track with the model and the level; the wheel and the arrow keys step one
 * level at a time and lift it briefly too.
 */
export function EffortSlider({
  noun,
  levels,
  defaultLevel,
  value,
  modelLabel,
  tooltip,
  onChange,
  fast,
  onFastChange,
}: {
  /** "Effort" or "Reasoning", whichever the agent calls it. */
  noun: string;
  levels: readonly string[];
  /** The level a message goes with when none is picked. Reset returns to it. */
  defaultLevel: string | undefined;
  /** The level picked for the next message. Undefined uses the default. */
  value: string | undefined;
  modelLabel: string;
  tooltip: string;
  onChange(level: string | undefined): void;
  /** Whether fast is on. Undefined when the model has no faster mode, which hides the switch. */
  fast?: boolean | undefined;
  onFastChange?: ((fast: boolean) => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const sliderRef = useRef<HTMLDivElement>(null);
  const placement = useAnchoredPlacement(open, triggerRef, popupRef, {
    prefer: "above",
    align: "end",
    gap: 8,
    edge: 8,
  });

  const shown = value ?? defaultLevel;
  const index = shown ? levels.findIndex((level) => level.toLowerCase() === shown.toLowerCase()) : -1;
  const last = Math.max(1, levels.length - 1);

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };

  const placed = placement !== undefined;
  useLayoutEffect(() => {
    if (placed) sliderRef.current?.focus({ preventScroll: true });
  }, [placed]);

  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null) =>
      target instanceof Node && (popupRef.current?.contains(target) || triggerRef.current?.contains(target));
    const onPointerDown = (event: globalThis.PointerEvent) => {
      if (!inside(event.target)) close(false);
    };
    const onScroll = (event: Event) => {
      if (scrollMovesAnchor(event, triggerRef.current)) close(false);
    };
    const onLeave = () => close(false);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onLeave);
    window.addEventListener("blur", onLeave);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onLeave);
      window.removeEventListener("blur", onLeave);
    };
  });

  const pick = (next: number) => {
    const level = levels[Math.min(levels.length - 1, Math.max(0, next))];
    if (level && level !== shown) onChange(level);
  };

  const step = (by: number) => pick((index < 0 ? Math.floor(last / 2) - (by > 0 ? 1 : 0) : index) + by);

  // The wheel steps one level per notch. React's wheel listener is passive, so it cannot keep the page still.
  const stepRef = useRef(step);
  stepRef.current = step;
  useEffect(() => {
    const slider = sliderRef.current;
    if (!open || !slider) return;
    let rest = 0;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const delta = Math.abs(event.deltaY) > Math.abs(event.deltaX) ? -event.deltaY : event.deltaX;
      rest += delta;
      // A trackpad sends many small deltas; one level per 40px of scroll keeps it from racing to the end.
      if (Math.abs(rest) < 40 && Math.abs(delta) < 40) return;
      stepRef.current(rest > 0 ? 1 : -1);
      rest = 0;
    };
    slider.addEventListener("wheel", onWheel, { passive: false });
    return () => slider.removeEventListener("wheel", onWheel);
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowRight" || event.key === "ArrowUp") step(1);
    else if (event.key === "ArrowLeft" || event.key === "ArrowDown") step(-1);
    else if (event.key === "Home") pick(0);
    else if (event.key === "End") pick(levels.length - 1);
    else if (event.key === "Enter") close(true);
    else return;
    event.preventDefault();
  };

  const label = shown ? reasoningLabel(shown) : "Model default";
  const changed = value !== undefined && value !== defaultLevel;
  const hint = reasoningHint(shown);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`select-ghost picker-trigger composer-reasoning${changed ? "" : " is-default"}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${noun}: ${label}`}
        data-tooltip={open ? undefined : tooltip}
        onClick={() => (open ? close(false) : setOpen(true))}
        onKeyDown={(event) => {
          if (open || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
          event.preventDefault();
          setOpen(true);
        }}
      >
        <EffortDial fraction={index < 0 ? 0.5 : index / last} />
        {/* Keyed by level, so the chip's name lifts in with each step, as the popup's does. */}
        <span className="picker-trigger-label effort-chip-label" key={shown ?? noun}>
          {shown ? reasoningLabel(shown) : noun}
        </span>
        {fast ? <Icon name="zap" size={11} className="effort-chip-fast" /> : null}
        <Icon name="chevronDown" size={12} className="picker-chevron" />
      </button>
      {open
        ? createPortal(
            <div
              ref={popupRef}
              className="effort-popup"
              role="dialog"
              aria-label={noun}
              data-side={placement && "top" in placement ? "bottom" : "top"}
              style={placement ? { ...placement, maxHeight: undefined } : { left: 0, top: 0, visibility: "hidden" }}
              onKeyDown={(event) => {
                if (event.key !== "Escape" && event.key !== "Tab") return;
                event.preventDefault();
                event.stopPropagation();
                close(true);
              }}
            >
              <div className="effort-head">
                <span className="effort-noun">{noun}</span>
                <span className="effort-spacer" />
                {fast !== undefined && onFastChange ? (
                  <button
                    type="button"
                    className={`effort-fast${fast ? " is-on" : ""}`}
                    aria-pressed={fast}
                    data-tooltip={
                      fast
                        ? "Fast mode is on: quicker answers, billed at a higher rate"
                        : "Fast mode: quicker answers from the same model, billed at a higher rate"
                    }
                    onClick={() => onFastChange(!fast)}
                  >
                    <Icon name="zap" size={12} />
                    Fast
                  </button>
                ) : null}
                {changed && defaultLevel ? (
                  <button
                    type="button"
                    className="effort-reset"
                    aria-label={`Back to ${reasoningLabel(defaultLevel)}`}
                    data-tooltip={`Back to ${reasoningLabel(defaultLevel)}`}
                    onClick={() => onChange(undefined)}
                  >
                    <Icon name="undo" size={12} />
                  </button>
                ) : null}
              </div>
              <ReasoningTrack
                levels={levels}
                index={index}
                label={reasoningLabel}
                model={modelLabel}
                ariaLabel={noun}
                sliderRef={sliderRef}
                onPick={pick}
                onKeyDown={onKeyDown}
              />
              {hint ? (
                <p className="effort-hint" key={hint}>
                  {hint}
                </p>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
