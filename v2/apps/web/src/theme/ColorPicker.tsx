import { isHexColor } from "@zli-v2/ui/themes";
import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { IconButton } from "../ui/Button.js";

type Hsv = { h: number; s: number; v: number };

export function hexToHsv(hex: string): Hsv {
  const value = Number.parseInt(hex.slice(1), 16);
  const r = ((value >> 16) & 255) / 255;
  const g = ((value >> 8) & 255) / 255;
  const b = (value & 255) / 255;
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  let h = 0;
  if (delta > 0) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
  }
  return { h: (h * 60 + 360) % 360, s: max === 0 ? 0 : delta / max, v: max };
}

export function hsvToHex({ h, s, v }: Hsv): string {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  return `#${[r, g, b]
    .map((channel) =>
      Math.round((channel + m) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** `#rrggbb` as "r, g, b", the way people type RGB. */
export function hexToRgbText(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}`;
}

/** Reads "r, g, b" (commas or spaces, optional rgb()), or nothing when it is not three 0-255 numbers. */
export function rgbTextToHex(text: string): string | undefined {
  const parts = text
    .replace(/rgba?\(|\)/giu, "")
    .split(/[\s,]+/u)
    .filter(Boolean);
  if (parts.length !== 3) return undefined;
  const numbers = parts.map(Number);
  if (numbers.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return undefined;
  return `#${numbers.map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

/** Accepts "#abc", "abc", "#aabbcc", or "aabbcc". */
export function parseHexText(text: string): string | undefined {
  let hex = text.trim().toLowerCase();
  if (!hex.startsWith("#")) hex = `#${hex}`;
  if (/^#[0-9a-f]{3}$/u.test(hex)) hex = `#${[...hex.slice(1)].map((c) => c + c).join("")}`;
  return isHexColor(hex) ? hex : undefined;
}

type EyeDropperResult = { sRGBHex: string };
type EyeDropperWindow = Window & { EyeDropper?: new () => { open(): Promise<EyeDropperResult> } };

/** Reads a color from anywhere on screen where the browser offers it (Chromium, so the desktop app). */
function eyeDropper(): (new () => { open(): Promise<EyeDropperResult> }) | undefined {
  return typeof window === "undefined" ? undefined : (window as EyeDropperWindow).EyeDropper;
}

const STEP = 0.02;

/** Ready-made colors for one click, by what the color is for. */
export const SWATCHES: Record<"surface" | "text" | "color", readonly string[]> = {
  surface: [
    "#000000",
    "#0a0a0a",
    "#141414",
    "#1c1c1f",
    "#111318",
    "#1a1f29",
    "#151013",
    "#07100a",
    "#f4f4f5",
    "#ffffff",
  ],
  text: ["#ffffff", "#ededed", "#d4d4d8", "#a3a3a3", "#8a8a8a", "#52525b", "#27272a", "#000000"],
  color: ["#4a6fdc", "#38bdf8", "#14b8a6", "#22c55e", "#eab308", "#f0883e", "#ef4444", "#e9a3c4", "#ec4899", "#a593e6"],
};

/** A text box that only hands on a value once it parses; anything else snaps back when it loses focus. */
export function ColorText({
  label,
  value,
  format,
  parse,
  onCommit,
  mono = true,
}: {
  label: string;
  value: string;
  format(hex: string): string;
  parse(text: string): string | undefined;
  onCommit(hex: string): void;
  mono?: boolean;
}) {
  const [text, setText] = useState(format(value));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(format(value));
  }, [value, editing, format]);
  return (
    <input
      className={`input input-sm color-text${mono ? " is-mono" : ""}`}
      value={text}
      spellCheck={false}
      aria-label={label}
      onFocus={() => setEditing(true)}
      onChange={(event) => {
        setText(event.target.value);
        const hex = parse(event.target.value);
        if (hex) onCommit(hex);
      }}
      onBlur={() => {
        setEditing(false);
        setText(format(value));
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
    />
  );
}

const identity = (hex: string) => hex;

/** The picker itself: one-click swatches, saturation and brightness, hue, and HEX and RGB fields. */
export function ColorPicker({
  label,
  value,
  swatches = [],
  onChange,
}: {
  label: string;
  value: string;
  /** Each swatch may carry a name for its tooltip, such as "Sidebar color". */
  swatches?: readonly (string | { color: string; name: string })[];
  onChange(hex: string): void;
}) {
  // Hue and saturation are kept here because grays and black carry no hue of their own to read back.
  const [hsv, setHsv] = useState(() => hexToHsv(value));
  const areaRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setHsv((previous) => (hsvToHex(previous) === value ? previous : hexToHsv(value)));
  }, [value]);

  const commit = (next: Hsv) => {
    setHsv(next);
    onChange(hsvToHex(next));
  };
  const set = (hex: string) => {
    setHsv(hexToHsv(hex));
    onChange(hex);
  };

  const pickAt = (event: PointerEvent<HTMLDivElement>) => {
    const rect = areaRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return;
    const s = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const v = 1 - Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
    commit({ ...hsv, s, v });
  };

  const onAreaKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-STEP, 0],
      ArrowRight: [STEP, 0],
      ArrowUp: [0, STEP],
      ArrowDown: [0, -STEP],
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    const scale = event.shiftKey ? 5 : 1;
    commit({
      ...hsv,
      s: Math.min(1, Math.max(0, hsv.s + move[0] * scale)),
      v: Math.min(1, Math.max(0, hsv.v + move[1] * scale)),
    });
  };

  const Dropper = eyeDropper();
  const entries = swatches.map((swatch) => (typeof swatch === "string" ? { color: swatch, name: swatch } : swatch));

  return (
    <div className="color-picker">
      {entries.length > 0 ? (
        <fieldset className="color-picker-swatches" aria-label={`${label}: quick picks`}>
          {entries.map((swatch) => (
            <button
              key={`${swatch.name}-${swatch.color}`}
              type="button"
              className="color-picker-swatch"
              style={{ background: swatch.color }}
              aria-pressed={swatch.color === value}
              aria-label={swatch.name}
              data-tooltip={swatch.name}
              onClick={() => set(swatch.color)}
            />
          ))}
        </fieldset>
      ) : null}
      <div
        ref={areaRef}
        className="color-picker-area"
        style={{ backgroundColor: hsvToHex({ h: hsv.h, s: 1, v: 1 }) }}
        role="slider"
        tabIndex={0}
        aria-label={`${label}: saturation and brightness`}
        aria-valuetext={`Saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`}
        aria-valuenow={Math.round(hsv.s * 100)}
        onKeyDown={onAreaKey}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          pickAt(event);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) pickAt(event);
        }}
      >
        <span className="color-picker-thumb" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }} />
      </div>
      <input
        className="color-picker-hue range"
        type="range"
        min={0}
        max={359}
        value={Math.round(hsv.h)}
        aria-label={`${label}: hue`}
        onChange={(event) => commit({ ...hsv, h: Number(event.target.value) })}
      />
      <div className="color-picker-fields">
        <div className="color-picker-field">
          <span className="color-picker-field-label" aria-hidden="true">
            Hex
          </span>
          <span className="color-picker-hex">
            <span className="color-picker-dot" style={{ background: value }} />
            <ColorText label={`${label}: hex`} value={value} format={identity} parse={parseHexText} onCommit={set} />
          </span>
        </div>
        <div className="color-picker-field">
          <span className="color-picker-field-label" aria-hidden="true">
            RGB
          </span>
          <ColorText label={`${label}: RGB`} value={value} format={hexToRgbText} parse={rgbTextToHex} onCommit={set} />
        </div>
        {Dropper ? (
          <IconButton
            label="Sample a color from the screen"
            icon="pipette"
            size="sm"
            className="color-picker-dropper"
            onClick={() => {
              void new Dropper()
                .open()
                .then((result) => {
                  const hex = parseHexText(result.sRGBHex);
                  if (hex) set(hex);
                })
                // Escape closes the sampler without a color, which is not a problem.
                .catch(() => undefined);
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

const GAP = 10;
const EDGE = 8;

/**
 * The picker in a card beside the row that opened it. It sits to the left of the editor so the row
 * stays in view, and closes on Escape or a click outside it and the row.
 */
export function ColorPopover({
  anchor,
  title,
  subtitle = "Choose a color",
  children,
  onClose,
}: {
  anchor: HTMLElement;
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose(): void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number }>();

  useLayoutEffect(() => {
    const place = () => {
      const card = cardRef.current;
      if (!card) return;
      const row = anchor.getBoundingClientRect();
      const panel = anchor.closest(".theme-editor")?.getBoundingClientRect() ?? row;
      const width = card.offsetWidth;
      const height = card.offsetHeight;
      const left = panel.left - width - GAP >= EDGE ? panel.left - width - GAP : Math.max(EDGE, row.left);
      const top = Math.min(Math.max(EDGE, row.top + row.height / 2 - height / 2), window.innerHeight - height - EDGE);
      setPosition({ left, top });
    };
    place();
    window.addEventListener("resize", place);
    const scroller = anchor.closest(".theme-editor-body");
    scroller?.addEventListener("scroll", place);
    return () => {
      window.removeEventListener("resize", place);
      scroller?.removeEventListener("scroll", place);
    };
  }, [anchor]);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
      anchor.focus();
    };
    const onPointer = (event: globalThis.PointerEvent) => {
      const target = event.target as Node;
      if (cardRef.current?.contains(target) || anchor.closest(".theme-row")?.contains(target)) return;
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointer, true);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={cardRef}
      className="color-popover"
      role="dialog"
      aria-label={title}
      style={position ? { left: position.left, top: position.top } : { visibility: "hidden" }}
    >
      <header className="color-popover-header">
        <span className="color-popover-title">{title}</span>
        <span className="color-popover-subtitle">{subtitle}</span>
      </header>
      {children}
    </div>,
    document.body,
  );
}
