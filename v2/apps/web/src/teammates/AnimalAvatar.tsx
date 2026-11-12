import { type ReactNode, useEffect, useRef, useState } from "react";

import { useAppSettings } from "../settings/appSettings.js";
import { ProviderMark } from "../ui/ProviderMark.js";
import { type Animal, animalLabel } from "./teammates.js";
import "./avatar.css";

/**
 * What the avatar shows. The eyes carry it: focused while a step runs, looking up while it thinks, wide when it
 * needs the person, happy when a turn ends, sleepy when stopped. Motion runs only while the agent does
 * something, and never with reduced motion or the setting off.
 */
export type AvatarMood = "idle" | "working" | "thinking" | "waiting" | "done" | "failed" | "stopped";

/** The mood for an agent's status. A turn that just ended looks happy for a moment, then rests. */
export function useAvatarMood(status: string | undefined, stepRunning: boolean): AvatarMood {
  const busy = status === "working";
  const [happy, setHappy] = useState(false);
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy && status === "idle") {
      setHappy(true);
      const timer = setTimeout(() => setHappy(false), 2_400);
      wasBusy.current = busy;
      return () => clearTimeout(timer);
    }
    wasBusy.current = busy;
    return undefined;
  }, [busy, status]);
  if (status === "waiting") return "waiting";
  if (status === "failed") return "failed";
  if (status === "stopped") return "stopped";
  if (busy || status === "starting") return stepRunning ? "working" : "thinking";
  return happy ? "done" : "idle";
}

const moodText: Record<AvatarMood, string> = {
  idle: "ready",
  working: "working",
  thinking: "thinking",
  waiting: "needs you",
  done: "done",
  failed: "failed",
  stopped: "stopped",
};

export function AnimalAvatar({
  animal,
  mood = "idle",
  size = 24,
  provider,
  name,
  className,
}: {
  animal: Animal;
  mood?: AvatarMood;
  size?: number;
  /** Draws the agent's own mark in the corner, so the animal never hides which agent it is. */
  provider?: string | undefined;
  /** Spoken with the mood, such as "Owl, working". Without it the avatar is decoration. */
  name?: string | undefined;
  className?: string | undefined;
}) {
  const { animateTeammates } = useAppSettings();
  return (
    <span
      className={`animal-avatar is-${animal} is-${mood}${animateTeammates ? "" : " is-still"}${className ? ` ${className}` : ""}`}
      style={{ width: size, height: size }}
      {...(name ? { role: "img", "aria-label": `${name}, ${moodText[mood]}` } : { "aria-hidden": true })}
      title={name ? `${name} (${animalLabel[animal]}), ${moodText[mood]}` : undefined}
    >
      <AnimalArt animal={animal} mood={mood} size={size} />
      {mood === "waiting" ? <span className="animal-avatar-flag" aria-hidden="true" /> : null}
      {provider && size >= 20 ? (
        <span className="animal-avatar-mark" aria-hidden="true">
          <ProviderMark provider={provider} size={Math.max(9, Math.round(size * 0.38))} />
        </span>
      ) : null}
    </span>
  );
}

/** The animal alone, as plain SVG with its colors inline, so it also draws outside the page (notification icons). */
export function AnimalArt({ animal, mood = "idle", size }: { animal: Animal; mood?: AvatarMood; size: number }) {
  const look = LOOKS[animal];
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      className="animal-avatar-art"
      viewBox="0 0 32 32"
      width={size}
      height={size}
      aria-hidden="true"
    >
      <g className="animal-avatar-body">
        <g fill={look.color}>{look.body}</g>
        {look.extra}
        <Eyes mood={mood} y={look.eyeY} gap={look.eyeGap} color={look.ink} />
      </g>
    </svg>
  );
}

/** Two eyes, drawn for the mood. They are the whole face, so each mood reads at 20 pixels. */
function Eyes({ mood, y, gap, color }: { mood: AvatarMood; y: number; gap: number; color: string }) {
  const line = {
    stroke: color,
    strokeWidth: 1.9,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    fill: "none",
  };
  const eye = (side: -1 | 1) => {
    const cx = 16 + side * gap;
    switch (mood) {
      case "working":
        // Focused, pointing in: > <
        return (
          <path
            d={`M${cx + side * 1.5} ${y - 1.9} L${cx - side * 1.2} ${y} L${cx + side * 1.5} ${y + 1.9}`}
            {...line}
          />
        );
      case "done":
        return <path d={`M${cx - 1.7} ${y + 0.9} Q${cx} ${y - 1.9} ${cx + 1.7} ${y + 0.9}`} {...line} />;
      case "stopped":
        return <path d={`M${cx - 1.7} ${y - 0.2} Q${cx} ${y + 1.9} ${cx + 1.7} ${y - 0.2}`} {...line} />;
      case "failed":
        return <path d={`M${cx - 1.6} ${y} L${cx + 1.6} ${y}`} {...line} />;
      case "waiting":
        return <circle cx={cx} cy={y} r={2.1} fill={color} />;
      case "thinking":
        return <rect x={cx - 0.5} y={y - 3.4} width={2.2} height={3.8} rx={1.1} fill={color} />;
      default:
        return <rect x={cx - 1.15} y={y - 2.3} width={2.3} height={4.6} rx={1.15} fill={color} />;
    }
  };
  return (
    <g className="animal-avatar-eyes">
      {eye(-1)}
      {eye(1)}
    </g>
  );
}

type Look = {
  color: string;
  /** Eye colour: dark on the bright animals, light on the panda's dark patches. */
  ink: string;
  eyeY: number;
  eyeGap: number;
  /** One solid silhouette in the animal's colour. */
  body: ReactNode;
  /** The few marks that are not the body colour, such as a panda's ears. */
  extra?: ReactNode;
};

const INK = "#16151a";

/**
 * Each animal is one bold shape in one colour, with the eyes doing the talking. The silhouette says which
 * animal it is: ears, tufts, bumps. No outlines and no small details, so it stays clear at sidebar size.
 */
const LOOKS: Record<Animal, Look> = {
  fox: {
    color: "#e8956a",
    ink: INK,
    eyeY: 17.5,
    eyeGap: 4.6,
    body: (
      <path d="M4.5 3.5 L12 9 C14.6 8.2 17.4 8.2 20 9 L27.5 3.5 L26.4 14 C26.4 21.2 21.8 27.6 16 29 C10.2 27.6 5.6 21.2 5.6 14 Z" />
    ),
    extra: (
      <>
        <path
          d="M8.6 20.2 C11 21.4 13.4 22 16 22 C18.6 22 21 21.4 23.4 20.2 C21.8 24.6 19 27.6 16 28.6 C13 27.6 10.2 24.6 8.6 20.2 Z"
          fill="#fff4e8"
        />
        <ellipse cx="16" cy="23.4" rx="1.6" ry="1.1" fill={INK} />
      </>
    ),
  },
  owl: {
    color: "#a795ec",
    ink: INK,
    eyeY: 16,
    eyeGap: 5,
    body: (
      <path d="M7.6 10.6 L7.2 6 L11.8 8 C14.5 7.1 17.5 7.1 20.2 8 L24.8 6 L24.4 10.6 C26.1 12.8 27 15.4 27 18.2 C27 24.7 22.1 29 16 29 C9.9 29 5 24.7 5 18.2 C5 15.4 5.9 12.8 7.6 10.6 Z" />
    ),
    extra: (
      <>
        <ellipse cx="16" cy="23.4" rx="6.6" ry="4.9" fill="#ffffff" opacity="0.28" />
        <path d="M14.5 19.4 L17.5 19.4 L16 22 Z" fill="#f1c06a" />
      </>
    ),
  },
  otter: {
    color: "#6cc4a4",
    ink: INK,
    eyeY: 16,
    eyeGap: 4.6,
    body: (
      <>
        <circle cx="7.4" cy="9.8" r="2.9" />
        <circle cx="24.6" cy="9.8" r="2.9" />
        <ellipse cx="16" cy="18.4" rx="11.6" ry="10.4" />
      </>
    ),
    extra: (
      <>
        <ellipse cx="16" cy="22.6" rx="5.6" ry="3.7" fill="#ffffff" opacity="0.32" />
        <ellipse cx="16" cy="20.6" rx="1.6" ry="1.1" fill={INK} />
      </>
    ),
  },
  cat: {
    color: "#7ea8ee",
    ink: INK,
    eyeY: 17.5,
    eyeGap: 4.6,
    body: (
      <path d="M6 13.4 C6 9.6 7.8 7.4 10.2 6.6 L9 2.4 L13.8 5.6 C15.3 5.4 16.7 5.4 18.2 5.6 L23 2.4 L21.8 6.6 C24.2 7.4 26 9.6 26 13.4 V20 C26 25.5 21.8 29 16 29 C10.2 29 6 25.5 6 20 Z" />
    ),
    extra: <path d="M14.7 21.4 L17.3 21.4 L16 23 Z" fill="#f6b7cf" />,
  },
  panda: {
    color: "#eeece6",
    ink: "#eeece6",
    eyeY: 17.6,
    eyeGap: 4.6,
    body: <circle cx="16" cy="18.2" r="11" />,
    extra: (
      <>
        <circle cx="7.6" cy="9.4" r="3.8" fill={INK} />
        <circle cx="24.4" cy="9.4" r="3.8" fill={INK} />
        <ellipse cx="11.4" cy="17.8" rx="3.4" ry="4" transform="rotate(18 11.4 17.8)" fill={INK} />
        <ellipse cx="20.6" cy="17.8" rx="3.4" ry="4" transform="rotate(-18 20.6 17.8)" fill={INK} />
        <ellipse cx="16" cy="23.2" rx="1.7" ry="1.1" fill={INK} />
      </>
    ),
  },
  penguin: {
    color: "#82c4e6",
    ink: INK,
    eyeY: 13.6,
    eyeGap: 4,
    body: (
      <>
        <path d="M16 3 C22.4 3 25.8 9.4 25.8 17 C25.8 24.4 21.4 29 16 29 C10.6 29 6.2 24.4 6.2 17 C6.2 9.4 9.6 3 16 3 Z" />
        <ellipse cx="5.6" cy="19.4" rx="1.9" ry="4.4" transform="rotate(18 5.6 19.4)" />
        <ellipse cx="26.4" cy="19.4" rx="1.9" ry="4.4" transform="rotate(-18 26.4 19.4)" />
      </>
    ),
    extra: <ellipse cx="16" cy="21.4" rx="6.4" ry="6.6" fill="#ffffff" opacity="0.38" />,
  },
  bear: {
    color: "#e3b36e",
    ink: INK,
    eyeY: 17,
    eyeGap: 4.4,
    body: (
      <>
        <circle cx="7.8" cy="9.4" r="4.1" />
        <circle cx="24.2" cy="9.4" r="4.1" />
        <circle cx="16" cy="18.2" r="11" />
      </>
    ),
    extra: <ellipse cx="16" cy="22.4" rx="1.9" ry="1.3" fill={INK} />,
  },
  rabbit: {
    color: "#ec97be",
    ink: INK,
    eyeY: 19.6,
    eyeGap: 4.2,
    body: (
      <>
        <rect x="8.6" y="1.4" width="5.4" height="14" rx="2.7" transform="rotate(-8 11.3 8.4)" />
        <rect x="18" y="1.4" width="5.4" height="14" rx="2.7" transform="rotate(8 20.7 8.4)" />
        <ellipse cx="16" cy="20.4" rx="10.6" ry="9.2" />
      </>
    ),
  },
  frog: {
    color: "#9ccc78",
    ink: INK,
    eyeY: 10.6,
    eyeGap: 6.6,
    body: (
      <>
        <circle cx="9.4" cy="10.6" r="5.2" />
        <circle cx="22.6" cy="10.6" r="5.2" />
        <path d="M3.6 21 C3.6 14.6 9 11.6 16 11.6 C23 11.6 28.4 14.6 28.4 21 C28.4 26.2 23 29 16 29 C9 29 3.6 26.2 3.6 21 Z" />
      </>
    ),
    extra: <path d="M12 21.6 Q16 24.4 20 21.6" stroke={INK} strokeWidth="1.5" strokeLinecap="round" fill="none" />,
  },
  chick: {
    color: "#ebd173",
    ink: INK,
    eyeY: 16.6,
    eyeGap: 4.4,
    body: (
      <>
        <path d="M14.2 7.4 C13.6 4.6 15.4 2.8 17.6 2 C17 3.8 18.4 5.2 18.2 7.4 Z" />
        <circle cx="16" cy="18" r="11" />
      </>
    ),
    extra: <path d="M14.4 20.4 L17.6 20.4 L16 22.8 Z" fill="#e39a5a" />,
  },
};
