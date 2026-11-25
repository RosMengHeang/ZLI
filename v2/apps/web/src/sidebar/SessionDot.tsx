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
 * A chat's state at the start of its row: three bars rising in turn while it works, an amber dot when it needs the
 * person, red when it failed, a filled dot when it finished out of sight, and a faint ring at rest.
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
  const tone = sessionTone(session.status, unread, quietStart);
  if (tone === "working")
    return (
      <span className="session-bars" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
    );
  return <span className={`session-dot is-${tone}`} aria-hidden="true" />;
}
