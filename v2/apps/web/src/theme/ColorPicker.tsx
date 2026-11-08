import { isHexColor } from "@zli-v2/ui/themes";
import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from "react";

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

/** Swatches for a quick pick, then saturation and brightness on a square, hue, and the hex value. */
export function ColorPicker({
  label,
  value,
  swatches = [],
  onChange,
}: {
  label: string;
  value: string;
  swatches?: readonly string[];
  onChange(hex: string): void;
}) {
  // Hue and saturation are kept here because grays and black carry no hue of their own to read back.
  const [hsv, setHsv] = useState(() => hexToHsv(value));
  const [text, setText] = useState(value);
  const areaRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setText(value);
    setHsv((previous) => (hsvToHex(previous) === value ? previous : hexToHsv(value)));
  }, [value]);

  const commit = (next: Hsv) => {
    setHsv(next);
    const hex = hsvToHex(next);
    setText(hex);
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

  return (
    <div className="color-picker">
      {swatches.length > 0 ? (
        <fieldset className="color-picker-swatches">
          <legend className="sr-only">{`${label}: quick picks`}</legend>
          {swatches.map((swatch) => (
            <button
              key={swatch}
              type="button"
              className="color-picker-swatch"
              style={{ background: swatch }}
              aria-pressed={swatch === value}
              aria-label={swatch}
              data-tooltip={swatch}
              onClick={() => {
                setHsv(hexToHsv(swatch));
                setText(swatch);
                onChange(swatch);
              }}
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
      <div className="color-picker-row">
        <input
          className="input input-sm is-mono color-picker-hex"
          value={text}
          spellCheck={false}
          maxLength={7}
          aria-label={`${label}: hex value`}
          onChange={(event) => {
            const next = event.target.value.trim();
            setText(next);
            const hex = (next.startsWith("#") ? next : `#${next}`).toLowerCase();
            if (isHexColor(hex)) {
              setHsv(hexToHsv(hex));
              onChange(hex);
            }
          }}
          onBlur={() => setText(value)}
        />
        {Dropper ? (
          <IconButton
            label="Sample a color from the screen"
            icon="pipette"
            size="sm"
            onClick={() => {
              void new Dropper()
                .open()
                .then((result) => {
                  const hex = result.sRGBHex.toLowerCase();
                  if (!isHexColor(hex)) return;
                  setHsv(hexToHsv(hex));
                  setText(hex);
                  onChange(hex);
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
