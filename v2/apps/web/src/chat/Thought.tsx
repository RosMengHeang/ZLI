import type { ThreadActivityProjection } from "@zli-v2/contracts";
import { useLayoutEffect, useRef } from "react";

import { Collapse } from "../ui/Collapse.js";
import { Icon } from "../ui/Icon.js";
import { Markdown } from "./Markdown.js";

type Activity = ThreadActivityProjection;

/** Seconds as "8s", "1m 05s", or "1h 02m". */
export function elapsedLabel(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** How long a finished step took, from when the runtime saw it start to when it saw it end. */
export function stepDuration(entry: Pick<Activity, "startedAt" | "completedAt">): number | undefined {
  if (!entry.startedAt || !entry.completedAt) return undefined;
  const milliseconds = Date.parse(entry.completedAt) - Date.parse(entry.startedAt);
  return Number.isFinite(milliseconds) && milliseconds >= 0 ? milliseconds : undefined;
}

/** A step's time for the end of its row. Anything under a second is not worth the space. */
export function durationLabel(milliseconds: number | undefined): string | undefined {
  return milliseconds === undefined || milliseconds < 1_000 ? undefined : elapsedLabel(milliseconds);
}

/** "Thought for 12s". A count of one or two seconds reads as noise, and older steps have no times at all. */
export function thoughtLabel(entry: Pick<Activity, "startedAt" | "completedAt">): string {
  const milliseconds = stepDuration(entry);
  return milliseconds === undefined || milliseconds < 2_000
    ? "Thought for a few seconds"
    : `Thought for ${elapsedLabel(milliseconds)}`;
}

// The line of thinking now lives with the rest of the live status, which the sidebar reads without this file.
export { latestThoughtLine } from "./liveStatus.js";

/**
 * The agent's thinking. While it streams it stays open and follows the newest words; once done it
 * folds to how long it took and opens on request. A block with no text is only its label.
 */
export function ThoughtStep({ entry, open, onToggle }: { entry: Activity; open: boolean; onToggle(): void }) {
  const running = entry.status === "running";
  const text = entry.text?.trim() ?? "";
  const shown = text.length > 0 && (running || open);
  const bodyRef = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each new part of the text moves the view to its end.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (running && body) body.scrollTop = body.scrollHeight;
  }, [running, text]);
  const label = (
    <>
      {text ? <Icon name="chevronRight" size={11} className="thought-chevron" /> : null}
      <span className={`thought-label${running ? " shimmer-text" : ""}`}>
        {running ? "Thinking…" : thoughtLabel(entry)}
      </span>
    </>
  );
  return (
    <li className={`step is-reasoning is-${entry.status}${shown ? " is-open" : ""}`}>
      {running || !text ? (
        <div className="step-row thought-row is-static" role={running ? "status" : undefined}>
          {label}
        </div>
      ) : (
        <button className="step-row thought-row" type="button" aria-expanded={open} onClick={onToggle}>
          {label}
        </button>
      )}
      <Collapse open={shown}>
        <div className="thought-body" ref={bodyRef}>
          <Markdown text={text} />
          {entry.truncated ? (
            <p className="thought-cut" title="The rest of this thinking was too long to keep">
              …
            </p>
          ) : null}
        </div>
      </Collapse>
    </li>
  );
}
