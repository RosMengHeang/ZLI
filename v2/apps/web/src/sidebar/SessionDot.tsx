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

/**
 * A chat's state as one dot: blue and breathing while it works, amber when it needs the person, red when it
 * failed, white when it finished out of sight, and a faint ring at rest.
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
  return <span className={`session-dot is-${sessionTone(session.status, unread, quietStart)}`} aria-hidden="true" />;
}
