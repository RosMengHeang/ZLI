import type { AgentSession, SessionStatus } from "../sessions/sessions.js";

/** What the dot says about a chat. Faces belong to buddies, so a chat in the list is a dot. */
export type DotTone = "working" | "waiting" | "failed" | "unread" | "idle";

const toneFor: Record<SessionStatus, DotTone> = {
  preparing: "working",
  starting: "working",
  working: "working",
  waiting: "waiting",
  ready: "idle",
  ended: "idle",
  failed: "failed",
};

export function sessionTone(status: SessionStatus, unread: boolean, quietStart = false): DotTone {
  const tone = quietStart && (status === "starting" || status === "preparing") ? "idle" : toneFor[status];
  return tone === "idle" && unread ? "unread" : tone;
}

const PIXELS = 9;

/**
 * A chat's state as a small orb of nine soft dots: a ripple runs out from the centre while it works, amber when it needs the person,
 * red when it failed, green when it finished out of sight, and grey and still at rest.
 */
export function SessionDot({
  session,
  unread = false,
  quietStart = false,
}: {
  session: Pick<AgentSession, "status">;
  unread?: boolean;
  quietStart?: boolean;
}) {
  return <PixelGrid tone={sessionTone(session.status, unread, quietStart)} />;
}

export function PixelGrid({ tone }: { tone: DotTone }) {
  return (
    <span className={`session-pixels is-${tone}`} aria-hidden="true">
      {Array.from({ length: PIXELS }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the pixels are a fixed grid that never reorders.
        <span key={index} />
      ))}
    </span>
  );
}
