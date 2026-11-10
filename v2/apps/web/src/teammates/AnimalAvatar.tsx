import { type ReactNode, useEffect, useRef, useState } from "react";

import { useAppSettings } from "../settings/appSettings.js";
import { ProviderMark } from "../ui/ProviderMark.js";
import { type Animal, animalLabel } from "./teammates.js";
import "./avatar.css";

/**
 * What the avatar shows. Working bobs while a step runs, thinking looks up, waiting raises a paw for the
 * person, done nods once. Motion only runs while the agent does something, and never with reduced motion.
 */
export type AvatarMood = "idle" | "working" | "thinking" | "waiting" | "done" | "failed" | "stopped";

/** The mood for an agent's status. A turn that just ended nods once, then rests. */
export function useAvatarMood(status: string | undefined, stepRunning: boolean): AvatarMood {
  const busy = status === "working";
  const [nodding, setNodding] = useState(false);
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy && status === "idle") {
      setNodding(true);
      const timer = setTimeout(() => setNodding(false), 1_400);
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
  return nodding ? "done" : "idle";
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
      <svg className="animal-avatar-art" viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
        <g className="animal-avatar-body">{ART[animal]}</g>
        <g className="animal-avatar-paw">
          <ellipse cx="26.5" cy="24" rx="3" ry="3.4" />
        </g>
      </svg>
      {mood === "waiting" ? <span className="animal-avatar-flag" aria-hidden="true" /> : null}
      {provider && size >= 20 ? (
        <span className="animal-avatar-mark" aria-hidden="true">
          <ProviderMark provider={provider} size={Math.max(9, Math.round(size * 0.38))} />
        </span>
      ) : null}
    </span>
  );
}

const INK = "#1d1b1f";

function Eyes({ y = 16, gap = 4, r = 1.6, color = INK }: { y?: number; gap?: number; r?: number; color?: string }) {
  return (
    <g className="animal-avatar-eyes">
      <circle cx={16 - gap} cy={y} r={r} fill={color} />
      <circle cx={16 + gap} cy={y} r={r} fill={color} />
    </g>
  );
}

/** Flat shapes on a 32 by 32 grid. Each animal keeps the colours it is known for. */
const ART: Record<Animal, ReactNode> = {
  fox: (
    <>
      <path d="M5 4 L13 10 L6.5 15 Z" fill="#e2763a" />
      <path d="M27 4 L19 10 L25.5 15 Z" fill="#e2763a" />
      <path d="M7 6.5 L11 10 L7.5 12.5 Z" fill="#3a2a24" />
      <path d="M25 6.5 L21 10 L24.5 12.5 Z" fill="#3a2a24" />
      <path d="M5.5 14 Q16 4 26.5 14 Q26 22 16 28 Q6 22 5.5 14 Z" fill="#e8843f" />
      <path d="M7 17 Q12 19 16 28 Q9 24.5 7 17 Z" fill="#f6efe6" />
      <path d="M25 17 Q20 19 16 28 Q23 24.5 25 17 Z" fill="#f6efe6" />
      <Eyes y={16.5} gap={4.6} />
      <ellipse cx="16" cy="24.6" rx="1.5" ry="1.1" fill={INK} />
    </>
  ),
  owl: (
    <>
      <path d="M6 6 L11.5 10 L7 13 Z" fill="#7d5a3c" />
      <path d="M26 6 L20.5 10 L25 13 Z" fill="#7d5a3c" />
      <circle cx="16" cy="17.5" r="11" fill="#9b7350" />
      <path d="M9 24 Q16 30 23 24 Q16 27 9 24 Z" fill="#c9a77e" />
      <circle cx="11.6" cy="15.5" r="4.3" fill="#f3ead9" />
      <circle cx="20.4" cy="15.5" r="4.3" fill="#f3ead9" />
      <Eyes y={15.5} gap={4.4} r={2} />
      <path d="M14.6 19 L17.4 19 L16 22.2 Z" fill="#e3a43a" />
    </>
  ),
  otter: (
    <>
      <circle cx="7.5" cy="10" r="2.8" fill="#5b5550" />
      <circle cx="24.5" cy="10" r="2.8" fill="#5b5550" />
      <circle cx="16" cy="17" r="11" fill="#77706a" />
      <ellipse cx="16" cy="21" rx="7.6" ry="5.4" fill="#e6ddd0" />
      <Eyes y={15} gap={4.4} />
      <ellipse cx="16" cy="19.6" rx="1.9" ry="1.3" fill={INK} />
      <path
        d="M11 21 L7 20.4 M11 22.4 L7.4 23 M21 21 L25 20.4 M21 22.4 L24.6 23"
        stroke="#8d8378"
        strokeWidth="0.7"
        strokeLinecap="round"
      />
    </>
  ),
  cat: (
    <>
      <path d="M5.5 4 L13 10.5 L5.5 14 Z" fill="#8e96a1" />
      <path d="M26.5 4 L19 10.5 L26.5 14 Z" fill="#8e96a1" />
      <path d="M7.4 7.4 L11 10.6 L7.4 12.4 Z" fill="#e7a6a6" />
      <path d="M24.6 7.4 L21 10.6 L24.6 12.4 Z" fill="#e7a6a6" />
      <circle cx="16" cy="18" r="10.6" fill="#a2a9b3" />
      <Eyes y={16.6} gap={4.2} />
      <path d="M14.8 20.2 L17.2 20.2 L16 21.6 Z" fill="#d98a8a" />
      <path
        d="M10.5 21 L5.8 20 M10.5 22.4 L6 23.4 M21.5 21 L26.2 20 M21.5 22.4 L26 23.4"
        stroke="#5c626b"
        strokeWidth="0.7"
        strokeLinecap="round"
      />
    </>
  ),
  panda: (
    <>
      <circle cx="7.5" cy="8.5" r="3.6" fill="#26262b" />
      <circle cx="24.5" cy="8.5" r="3.6" fill="#26262b" />
      <circle cx="16" cy="17" r="11" fill="#eeebe4" />
      <ellipse cx="11.4" cy="16.4" rx="3" ry="3.9" transform="rotate(20 11.4 16.4)" fill="#26262b" />
      <ellipse cx="20.6" cy="16.4" rx="3" ry="3.9" transform="rotate(-20 20.6 16.4)" fill="#26262b" />
      <Eyes y={16} gap={4.4} r={1.1} color="#f4f2ec" />
      <ellipse cx="16" cy="21.4" rx="1.8" ry="1.2" fill="#26262b" />
    </>
  ),
  penguin: (
    <>
      <circle cx="16" cy="17" r="11" fill="#2f3542" />
      <path d="M8.6 17 Q8.6 9.6 16 12.6 Q23.4 9.6 23.4 17 Q23.4 25.6 16 25.6 Q8.6 25.6 8.6 17 Z" fill="#f2efe8" />
      <Eyes y={16} gap={3.6} />
      <path d="M14 18.6 L18 18.6 L16 21.4 Z" fill="#eda23c" />
      <circle cx="10.6" cy="20.4" r="1.2" fill="#f0b7b0" />
      <circle cx="21.4" cy="20.4" r="1.2" fill="#f0b7b0" />
    </>
  ),
  bear: (
    <>
      <circle cx="8" cy="8.6" r="3.6" fill="#8c5833" />
      <circle cx="24" cy="8.6" r="3.6" fill="#8c5833" />
      <circle cx="8" cy="8.6" r="1.8" fill="#c48a5c" />
      <circle cx="24" cy="8.6" r="1.8" fill="#c48a5c" />
      <circle cx="16" cy="17" r="11" fill="#9e6640" />
      <ellipse cx="16" cy="21" rx="5.4" ry="4.2" fill="#d7a676" />
      <Eyes y={15} gap={4.4} />
      <ellipse cx="16" cy="19.4" rx="2" ry="1.4" fill={INK} />
    </>
  ),
  rabbit: (
    <>
      <rect x="9" y="1.5" width="4.6" height="13" rx="2.3" fill="#d9d3c9" />
      <rect x="18.4" y="1.5" width="4.6" height="13" rx="2.3" fill="#d9d3c9" />
      <rect x="10.3" y="3.4" width="2" height="9" rx="1" fill="#eab3b3" />
      <rect x="19.7" y="3.4" width="2" height="9" rx="1" fill="#eab3b3" />
      <circle cx="16" cy="19.4" r="9.8" fill="#e3ded5" />
      <Eyes y={18.4} gap={4} />
      <path d="M14.9 21.6 L17.1 21.6 L16 22.9 Z" fill="#d98a8a" />
    </>
  ),
};
