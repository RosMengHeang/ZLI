import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { scrollMovesAnchor, useAnchoredPlacement } from "../ui/anchoredPopup.js";
import { Icon } from "../ui/Icon.js";
import { ReasoningMeter } from "./ReasoningMeter.js";
import { reasoningHint, reasoningLabel } from "./reasoning.js";

/**
 * Effort as a slider: the levels sit on one track from least to most thinking, so a pick reads as "more" or
 * "less" at a glance. The knob carries the same rising bars as the chip in the message box, and each level's
 * name sits under its stop, so the slider says where it is without a separate legend. Dragging moves the knob
 * with the pointer and lets go onto the nearest level; the wheel and the arrow keys step one level at a time.
 */
export function EffortSlider({
  noun,
  levels,
  defaultLevel,
  value,
  modelLabel,
  tooltip,
  onChange,
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
}) {
  const [open, setOpen] = useState(false);
  /** Where the knob sits while it is dragged, 0 to 1. Undefined lets it rest on the level. */
  const [drag, setDrag] = useState<number>();
  /** The last input was a key, so the knob shows its focus ring. A click or drag hides it again. */
  const [keyed, setKeyed] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const sliderRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const placement = useAnchoredPlacement(open, triggerRef, popupRef, {
    prefer: "above",
    align: "end",
    gap: 8,
    edge: 8,
  });

  const shown = value ?? defaultLevel;
  const index = shown ? levels.findIndex((level) => level.toLowerCase() === shown.toLowerCase()) : -1;
  const last = Math.max(1, levels.length - 1);
  const position = drag ?? (index < 0 ? 0 : index / last);

  const close = (returnFocus: boolean) => {
    setOpen(false);
    setDrag(undefined);
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

  const fraction = (clientX: number) => {
    const track = trackRef.current?.getBoundingClientRect();
    if (!track || track.width === 0) return undefined;
    return Math.min(1, Math.max(0, (clientX - track.left) / track.width));
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    setKeyed(false);
    sliderRef.current?.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const at = fraction(event.clientX);
    if (at === undefined) return;
    setDrag(at);
    pick(Math.round(at * last));
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (drag === undefined) return;
    const at = fraction(event.clientX);
    if (at === undefined) return;
    setDrag(at);
    pick(Math.round(at * last));
  };

  // Letting go hands the knob back to the level, and the transition carries it onto the stop.
  const onPointerUp = () => setDrag(undefined);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowRight" || event.key === "ArrowUp") step(1);
    else if (event.key === "ArrowLeft" || event.key === "ArrowDown") step(-1);
    else if (event.key === "Home") pick(0);
    else if (event.key === "End") pick(levels.length - 1);
    else if (event.key === "Enter") close(true);
    else return;
    event.preventDefault();
    setKeyed(true);
  };

  const label = shown ? reasoningLabel(shown) : "Model default";
  const changed = value !== undefined && value !== defaultLevel;
  const sub = changed || !shown ? modelLabel : `${modelLabel} · default`;
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
        <ReasoningMeter level={shown} />
        <span className="picker-trigger-label">{shown ? reasoningLabel(shown) : noun}</span>
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
                {/* Keyed by level, so each change replays the short lift-in on the new name. */}
                <span className="effort-level" key={label}>
                  {label}
                </span>
                <span className="effort-model">{sub}</span>
                {changed && defaultLevel ? (
                  <button
                    type="button"
                    className="effort-reset"
                    aria-label={`Back to ${reasoningLabel(defaultLevel)}`}
                    data-tooltip={`Back to ${reasoningLabel(defaultLevel)}`}
                    onClick={() => onChange(undefined)}
                  >
                    <Icon name="undo" size={13} />
                  </button>
                ) : null}
              </div>
              <div
                ref={sliderRef}
                className={`effort-slider${index < 0 ? " is-unset" : ""}${drag === undefined ? "" : " is-dragging"}${keyed ? " is-keyed" : ""}`}
                style={{ "--effort": position } as CSSProperties}
                role="slider"
                tabIndex={0}
                aria-label={noun}
                aria-valuemin={0}
                aria-valuemax={levels.length - 1}
                aria-valuenow={Math.max(0, index)}
                aria-valuetext={label}
                onKeyDown={onKeyDown}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
              >
                {index < 0 && drag === undefined ? null : <span className="effort-fill" />}
                <div ref={trackRef} className="effort-rail">
                  {levels.map((level, stop) => (
                    <span
                      key={level}
                      className={`effort-stop${stop / last < position ? " is-on" : ""}`}
                      style={{ left: `${(stop / last) * 100}%` }}
                    />
                  ))}
                  {index < 0 && drag === undefined ? null : (
                    <span className="effort-knob">
                      <ReasoningMeter level={shown} />
                    </span>
                  )}
                </div>
              </div>
              <div className="effort-scale" aria-hidden="true">
                {levels.map((level, stop) => (
                  <button
                    key={level}
                    type="button"
                    tabIndex={-1}
                    className={`effort-scale-label${stop === index ? " is-on" : ""}`}
                    style={{ left: `${(stop / last) * 100}%` }}
                    onClick={() => pick(stop)}
                  >
                    {reasoningLabel(level)}
                  </button>
                ))}
              </div>
              <p className="effort-hint">{hint ?? "Drag, scroll, or use the arrow keys to pick a level."}</p>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
