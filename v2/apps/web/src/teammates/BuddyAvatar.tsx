import type { BuddyLook } from "@zli-v2/contracts";
import { useEffect, useRef, useState } from "react";
import { useAppSettings } from "../settings/appSettings.js";
import { ProviderMark } from "../ui/ProviderMark.js";

import { type Buddy, buddyHex } from "./buddies.js";
import { PixelBody } from "./pixelBuddies.js";
import "./buddy.css";

/**
 * What the buddy shows. The eyes and a little motion carry it: a hop when a task arrives, eyes on the work while a
 * step runs, eyes up while it thinks, wide eyes and hops when it needs the person, a happy hop when a turn ends.
 */
export type AvatarMood = "idle" | "ack" | "working" | "thinking" | "waiting" | "done" | "failed" | "stopped";

/** At this size and up a resting buddy breathes and looks around; smaller ones rest still in lists. */
const LARGE = 40;

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

/** The corner dot: amber when it needs the person, green when a turn just ended, red when it failed. */
const flagFor: Partial<Record<AvatarMood, string>> = { waiting: "", done: " is-done", failed: " is-failed" };

export function BuddyAvatar({
  buddy,
  look = "blob",
  mood = "idle",
  size = 24,
  provider,
  name,
  className,
}: {
  buddy: Buddy;
  /** Its pixel body. */
  look?: BuddyLook | undefined;
  mood?: AvatarMood;
  size?: number;
  /** Draws the agent's own mark in the corner, so the buddy never hides which agent it is. */
  provider?: string | undefined;
  /** Spoken with the mood, such as "Reviewer, working". Without it the buddy is decoration. */
  name?: string | undefined;
  className?: string | undefined;
}) {
  const { animateTeammates } = useAppSettings();
  const classes = [
    "buddy-avatar",
    "is-tile",
    `is-${buddy}`,
    `is-${mood}`,
    size >= LARGE ? "is-large" : "",
    animateTeammates ? "" : "is-still",
    className ?? "",
  ].filter(Boolean);
  const flag = flagFor[mood];
  return (
    <span
      className={classes.join(" ")}
      style={{ width: size, height: size }}
      {...(name ? { role: "img", "aria-label": `${name}, ${moodText[mood]}` } : { "aria-hidden": true })}
      title={name ? `${name}, ${moodText[mood]}` : undefined}
    >
      <TileArt buddy={buddy} look={look} mood={mood} size={size} />
      {flag !== undefined ? <span className={`buddy-avatar-flag${flag}`} aria-hidden="true" /> : null}
      {provider && size >= 20 ? (
        <span className="buddy-avatar-mark" aria-hidden="true">
          <ProviderMark provider={provider} size={Math.max(9, Math.round(size * 0.38))} />
        </span>
      ) : null}
    </span>
  );
}

/**
 * The buddy: its pixel body in its color, with eyes that carry the mood. Plain SVG with its colors inline, so it
 * also draws outside the page (notification icons).
 */
export function TileArt({
  buddy,
  look = "blob",
  mood = "idle",
  size,
}: {
  buddy: Buddy;
  look?: BuddyLook | undefined;
  mood?: AvatarMood;
  size: number;
}) {
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
        <PixelBody look={look} color={buddyHex(buddy)} mood={mood} />
      </g>
    </svg>
  );
}
