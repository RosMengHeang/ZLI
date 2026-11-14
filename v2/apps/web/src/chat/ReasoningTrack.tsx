/*
 * Adapted from the AICSS "Reasoning Effort" component.
 * Copyright (c) 2026 AICSS. Licensed under the MIT License:
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
 * documentation files (the "Software"), to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
 * to permit persons to whom the Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or substantial portions of
 * the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
 * THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
 * CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
 * IN THE SOFTWARE.
 */

import {
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type Ref,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import "./reasoningTrack.css";

const TRACK = 256;
const HEIGHT = 32;
const RADIUS = HEIGHT / 2;
const BUMP_H = 20;
const REST_W = 27.2;
const DRAG_W = 33.6;
const REST_H = 27.2;
const EDGE_PAD = (HEIGHT - REST_H) / 2;
/** How long the label stays up after the wheel or a key moves the knob. */
const PEEK_MS = 900;

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const easeOut = (t: number) => 1 - (1 - t) ** 3;
const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

function centerFor(value: number, stops: number) {
  const span = TRACK - RADIUS * 2;
  return RADIUS + (value / Math.max(1, stops - 1)) * span;
}

const LEFT_SHOULDER = 23.572;
/** Space from each glyph edge to the foot of the label shoulder. */
const TEXT_SIDE = 20;
/** How far the outer foot walks down the cap once it passes the crown. */
const PHI_MAX = 0.6;
const PHI_REACH = 36;

const plateauFor = (textW: number) => Math.max(8, textW + TEXT_SIDE * 2 - LEFT_SHOULDER * 2);

function smoothstep(t: number) {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

function capFoot(side: -1 | 1, phi: number) {
  const crown = side === -1 ? RADIUS : TRACK - RADIUS;
  return { x: crown + side * RADIUS * Math.sin(phi), y: BUMP_H + RADIUS * (1 - Math.cos(phi)) };
}

function shellGeom(cx: number, plateauW: number) {
  const crownL = RADIUS;
  const crownR = TRACK - RADIUS;
  let topL = cx - plateauW / 2;
  let topR = topL + plateauW;
  let phiL = 0;
  let phiR = 0;

  const overflowL = crownL - (topL - LEFT_SHOULDER);
  if (overflowL > 0) {
    phiL = PHI_MAX * smoothstep(overflowL / PHI_REACH);
    const foot = capFoot(-1, phiL);
    const minTopL = foot.x + LEFT_SHOULDER * Math.cos(phiL);
    if (topL < minTopL) {
      topR += minTopL - topL;
      topL = minTopL;
    }
  }

  const overflowR = topR + LEFT_SHOULDER - crownR;
  if (overflowR > 0) {
    phiR = PHI_MAX * smoothstep(overflowR / PHI_REACH);
    const foot = capFoot(1, phiR);
    const maxTopR = foot.x - LEFT_SHOULDER * Math.cos(phiR);
    if (topR > maxTopR) {
      topL -= topR - maxTopR;
      topR = maxTopR;
    }
  }

  // The tilted shoulder is shorter in x, which would pull the text onto the outer edge. Grow the plateau
  // inward by that loss and keep the label with it.
  const insetL = phiL > 0 ? LEFT_SHOULDER * (1 - Math.cos(phiL)) : 0;
  const insetR = phiR > 0 ? LEFT_SHOULDER * (1 - Math.cos(phiR)) : 0;
  topR += insetL;
  topL -= insetR;

  return { topL, topR, phiL, phiR, insetL, insetR };
}

/** Reference shoulder. phi tilts the foot onto the cap tangent; 0 is the flat scoop. */
function shoulderCmds(footX: number, footY: number, platX: number, platY: number, phi: number, dir: 1 | -1) {
  const xScale = Math.abs(platX - footX) / LEFT_SHOULDER;
  const yScale = Math.max(0.001, (footY - platY) / 20);
  const tangent = { x: dir * Math.cos(phi), y: -Math.sin(phi) };
  const map = (lx: number, ly: number) => ({ x: footX + dir * lx * xScale, y: footY + (ly - 20) * yScale });
  const h1 = 5.398 * xScale;
  const p0 = { x: footX, y: footY };
  const c1 = { x: footX + tangent.x * h1, y: footY + tangent.y * h1 };
  const c2 = map(10.012, 16.114);
  const p1 = map(10.93, 10.794);
  const c3 = map(11.916, 4.577);
  const c4 = map(17.277, 0);
  const p3 = { x: platX, y: platY };
  const fmt = (p: { x: number; y: number }) => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
  if (dir === 1) return `C${fmt(c1)} ${fmt(c2)} ${fmt(p1)}C${fmt(c3)} ${fmt(c4)} ${fmt(p3)}`;
  return `C${fmt(c4)} ${fmt(c3)} ${fmt(p1)}C${fmt(c2)} ${fmt(c1)} ${fmt(p0)}`;
}

/** One outline: the pill, with the label shoulder grown out of its top edge. */
function shellPath(cx: number, open: number, plateauW: number) {
  const trackTop = BUMP_H;
  const trackBot = BUMP_H + HEIGHT;
  const crownL = RADIUS;
  const crownR = TRACK - RADIUS;
  if (open < 0.012) {
    return `M${crownL} ${trackTop}H${crownR}A${RADIUS} ${RADIUS} 0 0 1 ${crownR} ${trackBot}H${crownL}A${RADIUS} ${RADIUS} 0 0 1 ${crownL} ${trackTop}Z`;
  }

  const bumpTop = BUMP_H * (1 - open);
  const { topL, topR, phiL, phiR } = shellGeom(cx, plateauW);
  const cmds = [`M${crownL} ${trackBot}`];

  if (phiL > 0.001) {
    const foot = capFoot(-1, phiL);
    cmds.push(`A${RADIUS} ${RADIUS} 0 0 1 ${foot.x.toFixed(2)} ${foot.y.toFixed(2)}`);
    cmds.push(shoulderCmds(foot.x, foot.y, topL, bumpTop, phiL, 1));
  } else {
    cmds.push(`A${RADIUS} ${RADIUS} 0 0 1 ${crownL} ${trackTop}`);
    const footL = topL - LEFT_SHOULDER;
    if (footL > crownL + 0.4) cmds.push(`H${footL.toFixed(2)}`);
    cmds.push(shoulderCmds(footL, trackTop, topL, bumpTop, 0, 1));
  }

  if (topR > topL + 0.4) cmds.push(`H${topR.toFixed(2)}`);

  if (phiR > 0.001) {
    const foot = capFoot(1, phiR);
    cmds.push(shoulderCmds(foot.x, foot.y, topR, bumpTop, phiR, -1));
    cmds.push(`A${RADIUS} ${RADIUS} 0 0 1 ${crownR} ${trackBot}`);
  } else {
    const footR = topR + LEFT_SHOULDER;
    cmds.push(shoulderCmds(footR, trackTop, topR, bumpTop, 0, -1));
    if (footR < crownR - 0.4) cmds.push(`H${crownR}`);
    cmds.push(`A${RADIUS} ${RADIUS} 0 0 1 ${crownR} ${trackBot}`);
  }

  cmds.push(`H${crownL}Z`);
  return cmds.join("");
}

/** Runs `frame` with an eased 0..1 over `ms` after `delay`, and returns a cancel. */
function tween(ms: number, frame: (eased: number, done: boolean) => void, delay = 0) {
  const start = performance.now();
  let raf = 0;
  const step = (now: number) => {
    const elapsed = now - start - delay;
    if (elapsed < 0) {
      raf = requestAnimationFrame(step);
      return;
    }
    const t = Math.min(1, elapsed / ms);
    frame(easeOut(t), t === 1);
    if (t < 1) raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return () => cancelAnimationFrame(raf);
}

/**
 * The effort track: a pill with a tick per level, a blue fill up to a white knob, and while the knob is held
 * (or just moved by the wheel or a key) a shoulder that grows out of the track with the model and the level on
 * it. Dragging moves the knob freely and lets go onto the nearest level.
 */
export function ReasoningTrack({
  levels,
  index,
  label,
  model,
  ariaLabel,
  sliderRef,
  onPick,
  onKeyDown,
}: {
  levels: readonly string[];
  /** The picked level. -1 when none is set; the knob then rests on the first stop. */
  index: number;
  label(level: string): string;
  /** Shown before the level on the shoulder. */
  model: string;
  ariaLabel: string;
  sliderRef?: Ref<HTMLDivElement>;
  onPick(index: number): void;
  onKeyDown(event: KeyboardEvent<HTMLDivElement>): void;
}) {
  const stops = levels.length;
  const target = Math.max(0, index);
  const trackRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const valueRef = useRef(target);
  const displayRef = useRef(target);
  const openRef = useRef(0);
  const revealRef = useRef(0);
  const draggingRef = useRef(false);
  const [display, setDisplay] = useState(target);
  const [open, setOpen] = useState(0);
  const [reveal, setReveal] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [peek, setPeek] = useState(false);
  const [textW, setTextW] = useState(64);
  const plateauTarget = plateauFor(textW);
  const plateauRef = useRef(plateauTarget);
  const [plateauW, setPlateauW] = useState(plateauTarget);
  const gradId = useId().replace(/:/g, "");
  const raised = dragging || peek;

  // The level changed from outside a drag (the wheel, a key, reset): glide there and lift the label briefly.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (draggingRef.current || Math.abs(displayRef.current - target) < 0.001) return;
    valueRef.current = target;
    setPeek(true);
    const hide = window.setTimeout(() => setPeek(false), PEEK_MS);
    if (reducedMotion()) {
      displayRef.current = target;
      setDisplay(target);
      return () => window.clearTimeout(hide);
    }
    const from = displayRef.current;
    const stop = tween(220, (e) => {
      displayRef.current = from + (target - from) * e;
      setDisplay(displayRef.current);
    });
    return () => {
      stop();
      window.clearTimeout(hide);
    };
  }, [target]);

  // Open or fold the shoulder. Letting go of a drag also settles the knob onto the nearest level.
  useEffect(() => {
    const toOpen = raised ? 1 : 0;
    const fromOpen = openRef.current;
    const fromValue = displayRef.current;
    const settle = !dragging && !peek;
    const targetValue = settle ? Math.round(valueRef.current) : fromValue;
    if (reducedMotion()) {
      openRef.current = toOpen;
      setOpen(toOpen);
      if (settle) {
        valueRef.current = targetValue;
        displayRef.current = targetValue;
        setDisplay(targetValue);
      }
      return;
    }
    return tween(220, (e, done) => {
      openRef.current = fromOpen + (toOpen - fromOpen) * e;
      setOpen(openRef.current);
      if (settle) {
        displayRef.current = fromValue + (targetValue - fromValue) * e;
        setDisplay(displayRef.current);
        if (done) valueRef.current = targetValue;
      }
    });
  }, [raised, dragging, peek]);

  useEffect(() => {
    const from = plateauRef.current;
    const to = plateauTarget;
    if (reducedMotion() || Math.abs(to - from) < 0.3) {
      plateauRef.current = to;
      setPlateauW(to);
      return;
    }
    return tween(90, (e) => {
      plateauRef.current = from + (to - from) * e;
      setPlateauW(plateauRef.current);
    });
  }, [plateauTarget]);

  useEffect(() => {
    const to = raised ? 1 : 0;
    const from = revealRef.current;
    if (reducedMotion()) {
      revealRef.current = to;
      setReveal(to);
      return;
    }
    return tween(
      raised ? 132 : 90,
      (e) => {
        revealRef.current = from + (to - from) * e;
        setReveal(revealRef.current);
      },
      raised ? 85 : 0,
    );
  }, [raised]);

  const commit = (next: number) => {
    valueRef.current = next;
    displayRef.current = next;
    setDisplay(next);
  };

  const valueFrom = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= RADIUS * 2) return valueRef.current;
    const t = (clientX - rect.left - RADIUS) / (rect.width - RADIUS * 2);
    return clamp(t * (stops - 1), 0, stops - 1);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    draggingRef.current = true;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture needs a trusted event.
    }
    setDragging(true);
    commit(valueFrom(event.clientX));
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (draggingRef.current) commit(valueFrom(event.clientX));
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Ignore when the event was not trusted.
    }
    setDragging(false);
    const landed = Math.round(valueRef.current);
    if (landed !== index) onPick(landed);
  };

  const center = centerFor(display, stops);
  const thumbW = REST_W + (DRAG_W - REST_W) * open;
  let thumbLeft = center - thumbW / 2;
  let thumbRight = thumbLeft + thumbW;
  if (thumbLeft < EDGE_PAD) {
    thumbLeft = EDGE_PAD;
    thumbRight = thumbLeft + thumbW;
  }
  if (thumbRight > TRACK - EDGE_PAD) {
    thumbRight = TRACK - EDGE_PAD;
    thumbLeft = thumbRight - thumbW;
  }
  const fillW = Math.min(TRACK, thumbRight + EDGE_PAD);
  const active = clamp(Math.round(display), 0, stops - 1);
  const level = label(levels[active] ?? "");
  const plateau = shellGeom(center, plateauW);
  const labelX = (plateau.topL + plateau.topR) / 2 + (plateau.insetL - plateau.insetR) / 2;

  useLayoutEffect(() => {
    const w = labelRef.current?.getBoundingClientRect().width ?? 0;
    if (w > 0 && Math.abs(w - textW) > 0.4) setTextW(w);
  });

  return (
    <div className="rt-root" data-dragging={dragging ? "true" : "false"}>
      <svg className="rt-shell" viewBox={`0 0 ${TRACK} ${BUMP_H + HEIGHT}`} aria-hidden="true">
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--rt-shell)" />
            <stop offset="1" stopColor="var(--rt-shell-2)" />
          </linearGradient>
        </defs>
        <path
          d={shellPath(center, open, plateauW)}
          fill={`url(#${gradId})`}
          stroke="var(--rt-line)"
          strokeWidth="0.5"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div
        ref={labelRef}
        className="rt-label"
        aria-hidden="true"
        style={{
          left: labelX,
          opacity: reveal,
          filter: reveal > 0.98 ? undefined : `blur(${((1 - reveal) * 3).toFixed(2)}px)`,
          transform: `translate(-50%, ${3 * (1 - open)}px)`,
        }}
      >
        <span key={level} className="rt-swap">
          {model ? <span className="rt-model">{model}</span> : null}
          <span className="rt-level">{level}</span>
        </span>
      </div>
      <div
        ref={(node) => {
          trackRef.current = node;
          if (typeof sliderRef === "function") sliderRef(node);
          else if (sliderRef) sliderRef.current = node;
        }}
        className="rt-track"
        role="slider"
        tabIndex={0}
        aria-label={ariaLabel}
        aria-valuemin={0}
        aria-valuemax={stops - 1}
        aria-valuenow={Math.max(0, index)}
        aria-valuetext={index < 0 ? "Model default" : label(levels[index] ?? "")}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
      >
        <div className="rt-fill" style={{ width: fillW }} />
        <div className="rt-thumb" style={{ left: thumbLeft, width: thumbW, height: REST_H, marginTop: -REST_H / 2 }} />
        {levels.map((stop, at) => {
          const x = centerFor(at, stops);
          const onThumb = x >= thumbLeft + 0.5 && x <= thumbRight - 0.5;
          return (
            <span
              key={stop}
              className="rt-tick"
              data-on-thumb={onThumb ? "true" : "false"}
              data-active={at === active && !onThumb ? "true" : "false"}
              style={{ left: x, height: 4.8 + (4.8 * at) / Math.max(1, stops - 1) }}
            />
          );
        })}
      </div>
    </div>
  );
}
