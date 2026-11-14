import type { ThreadProjection } from "@zli-v2/contracts";
import { useEffect, useState } from "react";

import { formatResetClock, formatResetIn } from "../limits/limits.js";
import { Icon } from "../ui/Icon.js";

type UsageLimit = NonNullable<ThreadProjection["usageLimit"]>;

/** What the note says, given the limit and the time. Kept apart from the markup for tests. */
export function usageLimitCopy(
  limit: UsageLimit,
  now: number,
): { detail: string; action?: "resume" | "cancel" | "continue" } {
  const resetAt = limit.resetsAt ? Date.parse(limit.resetsAt) : Number.NaN;
  if (Number.isNaN(resetAt)) return { detail: "The agent didn't say when it resets. Send a message to try again." };
  if (resetAt <= now)
    return limit.autoResume
      ? { detail: "Your limit has reset. Continuing now…" }
      : { detail: "Your limit has reset.", action: "continue" };
  const when = `${formatResetClock(limit.resetsAt ?? "", now) ?? ""}, in ${formatResetIn(limit.resetsAt, now)}`;
  return limit.autoResume
    ? { detail: `Continues by itself at ${when}.`, action: "cancel" }
    : { detail: `Resets at ${when}.`, action: "resume" };
}

/** Ticks once a minute while a reset is ahead, so the countdown stays right. */
function useMinuteClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

export function UsageLimitNote({
  limit,
  onAutoResume,
  onContinue,
}: {
  limit: UsageLimit;
  onAutoResume: (autoResume: boolean) => void;
  onContinue: () => void;
}) {
  const now = useMinuteClock(Boolean(limit.resetsAt));
  const { detail, action } = usageLimitCopy(limit, now);
  return (
    <div className="chat-note is-limit" role="status">
      <Icon name="gauge" size={13} />
      <span className="chat-note-text">
        <span className="chat-note-title">Usage limit reached</span> {detail}
      </span>
      {action === "resume" ? (
        <button type="button" onClick={() => onAutoResume(true)}>
          Resume at reset
        </button>
      ) : action === "cancel" ? (
        <button type="button" onClick={() => onAutoResume(false)}>
          Cancel auto-resume
        </button>
      ) : action === "continue" ? (
        <button type="button" onClick={onContinue}>
          Continue
        </button>
      ) : null}
    </div>
  );
}
