import { type ReactNode, useEffect, useRef, useState } from "react";

import { useAppSettings } from "../settings/appSettings.js";
import { ProviderMark } from "../ui/ProviderMark.js";
import { type Buddy, type BuddyBody, buddyBody, buddyHex, buddyName } from "./buddies.js";
import "./buddy.css";

/**
 * What the buddy shows. The eyes and a little motion carry it: a hop when a task arrives, rocking while a step
 * runs, a sway while it thinks, two hops when it needs the person, a spin when a turn ends, a nap when stopped.
 */
export type AvatarMood = "idle" | "ack" | "working" | "thinking" | "waiting" | "done" | "failed" | "stopped";

/** At this size and up a resting buddy breathes and looks around; smaller ones rest still in lists. */
const LARGE = 40;
/** Cheeks and shine only where they read; below this they turn into noise. */
const DETAILED = 30;

const ACK_MS = 600;
const DONE_MS = 2_400;

/** The mood for an agent's status. A task arriving gets a hop, and a turn that just ended looks happy for a moment. */
export function useAvatarMood(status: string | undefined, stepRunning: boolean): AvatarMood {
  const busy = status === "working" || status === "starting";
  const [flash, setFlash] = useState<"ack" | "done">();
  const wasBusy = useRef(busy);
  useEffect(() => {
    const was = wasBusy.current;
    wasBusy.current = busy;
    const next = !was && busy ? "ack" : was && !busy && status === "idle" ? "done" : undefined;
    if (!next) return undefined;
    setFlash(next);
    const timer = setTimeout(() => setFlash(undefined), next === "ack" ? ACK_MS : DONE_MS);
    return () => clearTimeout(timer);
  }, [busy, status]);
  if (status === "waiting") return "waiting";
  if (status === "failed") return "failed";
  if (status === "stopped") return "stopped";
  if (busy) return flash === "ack" ? "ack" : stepRunning ? "working" : "thinking";
  return flash === "done" ? "done" : "idle";
}

const moodText: Record<AvatarMood, string> = {
  idle: "ready",
  ack: "starting",
  working: "working",
  thinking: "thinking",
  waiting: "needs you",
  done: "done",
  failed: "failed",
  stopped: "stopped",
};

export function BuddyAvatar({
  buddy,
  mood = "idle",
  size = 24,
  provider,
  name,
  full = false,
  className,
}: {
  buddy: Buddy;
  mood?: AvatarMood;
  size?: number;
  /** Draws the agent's own mark in the corner, so the buddy never hides which agent it is. */
  provider?: string | undefined;
  /** Spoken with the mood, such as "Reviewer, working". Without it the buddy is decoration. */
  name?: string | undefined;
  /** Draw the whole buddy even when small, as the picker does to show each body. */
  full?: boolean;
  className?: string | undefined;
}) {
  const { animateTeammates } = useAppSettings();
  const tile = !full && size < LARGE;
  const classes = [
    "buddy-avatar",
    `is-${buddyBody(buddy)}`,
    `is-${mood}`,
    size >= LARGE ? "is-large" : "",
    tile ? "is-tile" : "",
    animateTeammates ? "" : "is-still",
    className ?? "",
  ].filter(Boolean);
  return (
    <span
      className={classes.join(" ")}
      style={{ width: size, height: size }}
      {...(name ? { role: "img", "aria-label": `${name}, ${moodText[mood]}` } : { "aria-hidden": true })}
      title={name ? `${name} (${buddyName(buddy)}), ${moodText[mood]}` : undefined}
    >
      {tile ? <TileArt buddy={buddy} mood={mood} size={size} /> : <BuddyArt buddy={buddy} mood={mood} size={size} />}
      {mood === "waiting" ? <span className="buddy-avatar-flag" aria-hidden="true" /> : null}
      {provider && size >= 20 ? (
        <span className="buddy-avatar-mark" aria-hidden="true">
          <ProviderMark provider={provider} size={Math.max(9, Math.round(size * 0.38))} />
        </span>
      ) : null}
    </span>
  );
}

/** The buddy alone, as plain SVG with its colors inline, so it also draws outside the page (notification icons). */
export function BuddyArt({ buddy, mood = "idle", size }: { buddy: Buddy; mood?: AvatarMood; size: number }) {
  const body = buddyBody(buddy);
  const look = LOOKS[body];
  const color = buddyHex(buddy);
  const ink = inkFor(color);
  const detailed = size >= DETAILED;
  const footColor = shade(color, -0.12);
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      className="buddy-avatar-art"
      viewBox="0 0 32 32"
      width={size}
      height={size}
      aria-hidden="true"
    >
      <g className="buddy-root">
        {look.noFeet ? null : (
          <>
            <rect className="buddy-foot is-left" x="10.6" y="24.6" width="3.6" height="4.4" rx="1.6" fill={footColor} />
            <rect
              className="buddy-foot is-right"
              x="17.8"
              y="24.6"
              width="3.6"
              height="4.4"
              rx="1.6"
              fill={footColor}
            />
          </>
        )}
        <g className="buddy-body">
          {look.back?.(color)}
          <g fill={color}>{look.shape}</g>
          {detailed && look.shine ? <Shine at={look.shine} /> : null}
          {look.extra?.(color)}
          <Face
            mood={mood}
            y={look.eyeY}
            ink={ink}
            cheekGap={detailed ? (look.cheekGap ?? 6.2) : undefined}
            glasses={look.glasses}
          />
        </g>
      </g>
      {mood === "thinking" ? (
        <g className="buddy-dots" fill="#e8e8ea">
          <circle cx="24.6" cy="3.4" r=".9" />
          <circle cx="27.2" cy="2" r="1.1" />
          <circle cx="30" cy=".4" r="1.3" />
        </g>
      ) : null}
      {mood === "stopped" ? (
        <text className="buddy-z" x="24.4" y="6" fontSize="5" fontWeight="700" fill="#c9c9d1" fontFamily="sans-serif">
          z
        </text>
      ) : null}
    </svg>
  );
}

/**
 * The buddy in lists: a rounded square in its color with only its eyes. At list size a whole body is mostly
 * feet and outline, and a column of different shapes reads as noise; the color and eyes carry it instead.
 */
export function TileArt({ buddy, mood = "idle", size }: { buddy: Buddy; mood?: AvatarMood; size: number }) {
  const color = buddyHex(buddy);
  const ink = inkFor(color);
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      className="buddy-avatar-art"
      viewBox="0 0 32 32"
      width={size}
      height={size}
      aria-hidden="true"
    >
      <g className="buddy-root">
        <rect x="2" y="2" width="28" height="28" rx="9.6" fill={color} />
        <g className="buddy-face">
          <TileEyes mood={mood} ink={ink} />
        </g>
      </g>
    </svg>
  );
}

/** Chunky cursor eyes with a glint, glancing right toward the chat; facing front when it needs the person. */
function TileEyes({ mood, ink }: { mood: AvatarMood; ink: string }) {
  const width = 5.1;
  const height = 7;
  const gap = 7.7;
  const top = 12.2;
  const left = mood === "waiting" || mood === "stopped" ? 9.6 : 10.4;
  const xs = [left, left + gap];
  const line = {
    stroke: ink,
    strokeWidth: 2.1,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    fill: "none",
  };
  const mid = top + height / 2;
  switch (mood) {
    case "working":
      return (
        <g className="buddy-eyes">
          {xs.map((x) => (
            <rect key={x} x={x - 0.3} y={top + height - 2.5} width={width + 0.6} height="2.5" rx="0.9" fill={ink} />
          ))}
        </g>
      );
    case "done":
      return (
        <>
          {xs.map((x) => (
            <path
              key={x}
              d={`M${x} ${mid + 1.2} L${x + width / 2} ${mid - 1.4} L${x + width} ${mid + 1.2}`}
              {...line}
            />
          ))}
        </>
      );
    case "failed":
      return (
        <>
          {xs.map((x) => (
            <path
              key={x}
              d={`M${x + 0.6} ${mid - 2} L${x + width - 0.6} ${mid + 2} M${x + width - 0.6} ${mid - 2} L${x + 0.6} ${mid + 2}`}
              {...line}
            />
          ))}
        </>
      );
    case "stopped":
      return (
        <>
          {xs.map((x) => (
            <path key={x} d={`M${x} ${mid + 0.6} H${x + width}`} {...line} />
          ))}
        </>
      );
    default: {
      const tall = mood === "waiting" ? height + 2.6 : mood === "thinking" ? height * 0.7 : height;
      const y = mood === "waiting" ? top - 1.6 : mood === "thinking" ? top - 1.8 : top;
      const shift = mood === "thinking" ? 1.2 : 0;
      return (
        <g className="buddy-eyes">
          {xs.map((x) => (
            <g key={x}>
              <rect x={x + shift} y={y} width={width} height={tall} rx="1.6" fill={ink} />
              <rect
                x={x + shift + width * 0.55}
                y={y + 1}
                width="1.5"
                height="1.5"
                rx="0.6"
                fill="#ffffff"
                opacity="0.9"
              />
            </g>
          ))}
        </g>
      );
    }
  }
}

function Shine({ at: [cx, cy, rx, ry, angle] }: { at: Shine }) {
  return (
    <ellipse cx={cx} cy={cy} rx={rx} ry={ry} transform={`rotate(${angle} ${cx} ${cy})`} fill="#ffffff" opacity="0.32" />
  );
}

/**
 * Two cursor-block eyes, glancing right toward the chat. They turn to face the person when it needs them and
 * when it sleeps. A small mouth shows only for the moods that need one.
 */
function Face({
  mood,
  y: eyeY,
  ink,
  cheekGap,
  glasses,
}: {
  mood: AvatarMood;
  y: number;
  ink: string;
  cheekGap: number | undefined;
  glasses: boolean | undefined;
}) {
  const look = mood === "waiting" || mood === "stopped" ? 0 : 1.1;
  const gap = 3.6;
  const y = eyeY + (mood === "thinking" ? -1.4 : 0);
  const line = {
    stroke: ink,
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    fill: "none",
  };
  const eye = (side: -1 | 1): ReactNode => {
    const x = 16 + look + side * gap + (mood === "thinking" ? 0.6 : 0);
    switch (mood) {
      case "working":
        return <rect x={x - 1.6} y={y + 0.8} width="3.2" height="1.5" rx="0.55" fill={ink} />;
      case "thinking":
        return <rect x={x - 1.25} y={y - 1.4} width="2.5" height="2.7" rx="0.7" fill={ink} />;
      case "waiting":
        return (
          <>
            <rect x={x - 1.5} y={y - 2.9} width="3" height="5.4" rx="0.8" fill={ink} />
            <rect x={x + 0.15} y={y - 2.3} width="0.9" height="0.9" rx="0.35" fill="#ffffff" opacity="0.9" />
          </>
        );
      case "done":
        return <path d={`M${x - 1.4} ${y + 0.6} L${x} ${y - 1} L${x + 1.4} ${y + 0.6}`} {...line} />;
      case "failed":
        return (
          <path
            d={`M${x - 1.1} ${y - 1.1} L${x + 1.1} ${y + 1.1} M${x + 1.1} ${y - 1.1} L${x - 1.1} ${y + 1.1}`}
            {...line}
            strokeWidth={1.4}
          />
        );
      case "stopped":
        return <path d={`M${x - 1.3} ${y + 0.2} Q${x} ${y + 1.4} ${x + 1.3} ${y + 0.2}`} {...line} strokeWidth={1.3} />;
      default:
        return (
          <>
            <rect x={x - 1.4} y={y - 1.8} width="2.8" height="3.6" rx="0.8" fill={ink} />
            <rect x={x + 0.15} y={y - 1.25} width="0.9" height="0.9" rx="0.35" fill="#ffffff" opacity="0.9" />
          </>
        );
    }
  };
  const mx = 16 + look;
  const my = eyeY + 3.6;
  const mouth: ReactNode =
    mood === "done" ? (
      <path d={`M${mx - 1.5} ${my - 0.4} Q${mx} ${my + 1.6} ${mx + 1.5} ${my - 0.4}Z`} fill={ink} />
    ) : mood === "waiting" ? (
      <ellipse cx={mx} cy={my + 0.2} rx="0.75" ry="0.95" fill={ink} />
    ) : mood === "failed" ? (
      <path d={`M${mx - 1.3} ${my + 0.6} Q${mx} ${my - 0.5} ${mx + 1.3} ${my + 0.6}`} {...line} strokeWidth={1.1} />
    ) : mood === "thinking" ? (
      <path d={`M${mx - 0.2} ${my - 0.2} H${mx + 1.3}`} {...line} strokeWidth={1.1} />
    ) : null;
  return (
    <g className="buddy-face">
      {cheekGap === undefined ? null : (
        <>
          <ellipse
            className="buddy-cheek"
            cx={mx - cheekGap}
            cy={eyeY + 2.4}
            rx="1.5"
            ry="0.85"
            fill="#ff5f87"
            opacity="0.38"
          />
          <ellipse
            className="buddy-cheek"
            cx={mx + cheekGap}
            cy={eyeY + 2.4}
            rx="1.5"
            ry="0.85"
            fill="#ff5f87"
            opacity="0.38"
          />
        </>
      )}
      <g className="buddy-eyes">
        {eye(-1)}
        {eye(1)}
      </g>
      {mouth}
      {glasses ? (
        <g fill="none" stroke={ink} strokeWidth="0.8">
          <circle cx={mx - gap} cy={eyeY} r="2.8" />
          <circle cx={mx + gap} cy={eyeY} r="2.8" />
          <path d={`M${mx - 0.5} ${eyeY - 0.3} H${mx + 0.5}`} />
        </g>
      ) : null}
    </g>
  );
}

/* ---------- Drawing helpers ---------- */

/** Dark eyes on light bodies, light eyes on dark ones. */
function inkFor(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const luma = 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return luma > 90 ? "#141417" : "#f4f4f6";
}

/** Lighter (amount > 0) or darker (amount < 0) version of a hex color, as rgb(). */
function shade(hex: string, amount: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.round(amount > 0 ? v + (255 - v) * amount : v * (1 + amount));
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

/** A polygon with soft corners: each corner becomes a curve that starts `k` of the way along its sides. */
function softPolygon(sides: number, radius: number, cx: number, cy: number, k: number): string {
  const points = Array.from({ length: sides }, (_, index) => {
    const angle = ((-90 + (360 / sides) * index) * Math.PI) / 180;
    return [cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius] as const;
  });
  const along = (a: readonly number[], b: readonly number[]) =>
    `${(a[0] ?? 0) + ((b[0] ?? 0) - (a[0] ?? 0)) * k} ${(a[1] ?? 0) + ((b[1] ?? 0) - (a[1] ?? 0)) * k}`;
  return `${points
    .map((corner, index) => {
      const before = points[(index + sides - 1) % sides] ?? corner;
      const after = points[(index + 1) % sides] ?? corner;
      return `${index ? "L" : "M"}${along(corner, before)} Q${corner[0]} ${corner[1]} ${along(corner, after)}`;
    })
    .join(" ")}Z`;
}

/* ---------- The twelve buddies ---------- */

/** A soft shine: centre x, centre y, radius x, radius y, rotation. */
type Shine = readonly [number, number, number, number, number];

type Look = {
  eyeY: number;
  /** The body, filled with the buddy's color. */
  shape: ReactNode;
  /** Drawn behind the body, such as a chimney. */
  back?: (color: string) => ReactNode;
  /** Its own small thing, drawn over the body. */
  extra?: (color: string) => ReactNode;
  shine?: Shine;
  /** How far the cheeks sit from the middle, for narrow bodies. */
  cheekGap?: number;
  noFeet?: boolean;
  glasses?: boolean;
};

const WHITE = "#ffffff";
const WEDGE = softPolygon(3, 14, 16, 17.2, 0.3);
const HOUSE = softPolygon(5, 13.4, 16, 15.6, 0.3);

/**
 * One family: every buddy has the same feet, cursor eyes and cheeks, and one small thing that is only its own.
 * Paths come from the approved mockup (docs/superpowers/specs/2026-11-13-buddies-mockup.html).
 */
const LOOKS: Record<BuddyBody, Look> = {
  gumdrop: {
    eyeY: 15.6,
    shine: [11, 10, 1.5, 2.8, 30],
    shape: <path d="M5.5 23 C5.5 12 10 4.5 16 4.5 C22 4.5 26.5 12 26.5 23 Q26.5 25.6 24 25.6 H8 Q5.5 25.6 5.5 23Z" />,
    extra: () => (
      <>
        <path
          d="M16 5 C16 3.4 16.4 2.4 17.2 1.6"
          stroke="#5a8f3c"
          strokeWidth="1.1"
          strokeLinecap="round"
          fill="none"
        />
        <path d="M17 2.4 C18.4 .4 21.6 .2 22.6 1.4 C21.4 3.4 18.6 3.6 17 2.4Z" fill="#7cc657" />
      </>
    ),
  },
  capsule: {
    eyeY: 12.8,
    cheekGap: 4.9,
    shine: [12, 7.6, 1.2, 2.6, 15],
    shape: <rect x="8.6" y="2.6" width="14.8" height="23.4" rx="7.4" />,
    extra: (color) => (
      <path
        d="M15.4 3 C14.2 .6 16.8 -.6 18 1 C18.8 2.2 17.4 3.2 16.6 2.4"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        fill="none"
      />
    ),
  },
  plus: {
    eyeY: 14.8,
    shine: [13.4, 6.8, 0.9, 2, 15],
    shape: (
      <>
        <rect x="10.6" y="3" width="10.8" height="23" rx="4.4" />
        <rect x="3.6" y="9.4" width="24.8" height="10.6" rx="4.4" />
      </>
    ),
    extra: () => (
      <>
        <path
          d="M16 3.6 L12.4 1.2 Q11.6 .9 11.6 1.8 V5.4 Q11.6 6.3 12.4 6 Z M16 3.6 L19.6 1.2 Q20.4 .9 20.4 1.8 V5.4 Q20.4 6.3 19.6 6 Z"
          fill={WHITE}
        />
        <circle cx="16" cy="3.6" r="1.2" fill="#ffd2e1" />
      </>
    ),
  },
  cloud: {
    eyeY: 17.4,
    shine: [11.4, 11.4, 1.3, 2.4, 40],
    shape: (
      <path d="M8 25.8 C4.4 25.8 2.6 23.2 3 20.4 C3.4 17.6 5.6 16.2 7.8 16.4 C7.8 10.6 11.4 7 16 7 C20.6 7 23.6 10.2 24.2 14.2 C27.2 14.2 29.4 16.8 29 20 C28.6 23.4 26.4 25.8 23.6 25.8Z" />
    ),
    extra: () => (
      <path d="M27.4 6.4 C27.4 6.4 25.8 8.6 25.8 9.6 a1.6 1.6 0 0 0 3.2 0 C29 8.6 27.4 6.4 27.4 6.4Z" fill="#9fd0ff" />
    ),
  },
  mushroom: {
    eyeY: 20.6,
    cheekGap: 3.9,
    shape: (
      <>
        <path d="M3.2 14.4 C3.2 7.8 9 3.6 16 3.6 C23 3.6 28.8 7.8 28.8 14.4 Q28.8 16.6 26.6 16.6 H5.4 Q3.2 16.6 3.2 14.4Z" />
        <rect x="9.6" y="14" width="12.8" height="12" rx="4" />
      </>
    ),
    extra: () => (
      <>
        <path d="M9.6 16.6 H22.4 V17.6 Q16 18.8 9.6 17.6Z" fill="#000000" opacity="0.14" />
        <g fill={WHITE} opacity="0.92">
          <circle cx="8.4" cy="10.6" r="1.7" />
          <circle cx="16.2" cy="6.8" r="2" />
          <circle cx="23.6" cy="11" r="1.4" />
          <circle cx="20" cy="12.4" r=".8" />
        </g>
      </>
    ),
  },
  peanut: {
    eyeY: 15.8,
    shine: [7.4, 13, 1.2, 2.4, 30],
    shape: (
      <>
        <circle cx="10.6" cy="16.6" r="8" />
        <circle cx="21.4" cy="15.4" r="8.4" />
        <rect x="10" y="13" width="12" height="12" rx="3" />
      </>
    ),
    extra: (color) => (
      <g stroke={shade(color, -0.28)} strokeLinecap="round" fill="none">
        <path d="M15.8 8.2 Q15.2 10 16 11.2" strokeWidth="1" />
        <path d="M7.4 20 l.9 .5 M24 21 l.9 -.4 M21.6 9.6 l.7 .6" strokeWidth=".9" />
      </g>
    ),
  },
  jelly: {
    eyeY: 14.6,
    noFeet: true,
    shine: [9.8, 8.4, 1.5, 3, 35],
    shape: (
      <path d="M4.6 15.4 C4.6 8.4 9.6 4 16 4 C22.4 4 27.4 8.4 27.4 15.4 V24 Q25.5 26.6 23.7 24 Q21.8 21.6 19.9 24 Q18 26.6 16 24 Q14 21.6 12.1 24 Q10.2 26.6 8.3 24 Q6.5 21.6 4.6 24Z" />
    ),
    extra: () => (
      <g fill="none" stroke="#7fe0bd">
        <circle cx="27" cy="3.4" r="1.5" strokeWidth=".8" />
        <circle cx="29.2" cy="6.4" r=".8" strokeWidth=".7" />
      </g>
    ),
  },
  wedge: {
    eyeY: 18.4,
    cheekGap: 5.4,
    shape: <path d={WEDGE} />,
    extra: (color) => (
      <g fill={shade(color, -0.2)}>
        <circle cx="10.6" cy="22.2" r="1.3" />
        <circle cx="22.4" cy="22.6" r="1.5" />
        <circle cx="16.4" cy="10.4" r="1.1" />
        <circle cx="17.6" cy="23.2" r=".7" />
      </g>
    ),
  },
  squircle: {
    eyeY: 15,
    glasses: true,
    shine: [8.8, 9.6, 1.2, 2.6, 25],
    shape: <rect x="5" y="5" width="22" height="20.6" rx="8.4" transform="rotate(-9 16 15.3)" />,
    extra: () => (
      <>
        <path d="M21.4 3.6 L25.6 6.8" stroke="#f2cf5b" strokeWidth="2.2" strokeLinecap="round" />
        <path d="M25.6 6.8 L26.6 7.6" stroke="#ef5a47" strokeWidth="2.2" strokeLinecap="round" />
      </>
    ),
  },
  bulb: {
    eyeY: 17,
    shine: [10.6, 11.4, 1.3, 2.6, 35],
    shape: (
      <path d="M16 2.6 C17.6 5 19 5.6 21 7.2 C25 10.2 27 13.8 27 17.6 C27 22.6 22.4 25.8 16 25.8 C9.6 25.8 5 22.6 5 17.6 C5 13.8 7 10.2 11 7.2 C13 5.6 14.4 5 16 2.6Z" />
    ),
    extra: (color) => (
      <>
        <path d="M16 3 C16.2 1.2 17.8 .4 18.8 1.4" stroke={color} strokeWidth="1.5" strokeLinecap="round" fill="none" />
        <path
          d="M12.2 9.6 Q11.4 12.6 12 15 M19.8 9.6 Q20.6 12.6 20 15"
          stroke={shade(color, -0.2)}
          strokeWidth=".8"
          strokeLinecap="round"
          fill="none"
          opacity="0.6"
        />
      </>
    ),
  },
  house: {
    eyeY: 16.6,
    shine: [10.8, 9.8, 1.1, 2.3, 40],
    back: (color) => <rect x="20.6" y="2.4" width="3.4" height="6.4" rx=".9" fill={shade(color, -0.25)} />,
    shape: <path d={HOUSE} />,
    extra: () => <circle className="buddy-puff" cx="22.3" cy="0.4" r="1.2" fill="#d6d6da" />,
  },
  bean: {
    eyeY: 15.6,
    shine: [7.4, 16, 1, 2.3, 10],
    shape: (
      <path d="M7 9 C10.6 4.4 20.6 3.6 25 8.6 C28.6 12.8 27.8 20 24.6 23.4 C20.8 27.4 11 27.4 7.2 23.6 C3.6 20 3.6 13.4 7 9Z" />
    ),
    extra: () => (
      <>
        <path d="M6.4 10.6 C7.4 5.6 12 3.4 16.4 3.6 C21 3.8 25.4 5.8 26.6 10.2 Q16.4 7.6 6.4 10.6Z" fill="#ef5a47" />
        <path d="M6.4 10.6 Q16.4 7.6 26.6 10.2 L26.8 11.6 Q16.4 9 6.2 12Z" fill="#c8402f" />
        <circle cx="16.8" cy="2.8" r="1.9" fill={WHITE} />
      </>
    ),
  },
};
