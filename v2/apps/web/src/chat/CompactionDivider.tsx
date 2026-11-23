import { useId, useState } from "react";

import { Collapse } from "../ui/Collapse.js";
import { formatTokens } from "../usage/usage.js";
import type { Compaction } from "./compaction.js";
import { Markdown } from "./Markdown.js";

export type CompactionState = "compacting" | "done" | "stopped";

/**
 * The quiet line where a chat was compacted: "Compacted · saved ~42k tokens". A summary the agent wrote
 * opens under it.
 */
export function CompactionDivider({
  compaction,
  state,
  saved,
}: {
  compaction: Compaction;
  state: CompactionState;
  saved: number | undefined;
}) {
  const [open, setOpen] = useState(false);
  const summaryId = useId();
  // A native compaction that ended but compacted nothing, or said it failed, says so in the agent's words.
  const outcome = state === "done" ? compaction.outcome : undefined;
  const detail = outcome === "failed" ? compaction.detail?.replace(/\s+/gu, " ").trim() : undefined;
  const text =
    state === "compacting"
      ? "Compacting…"
      : state === "stopped"
        ? "Compacting stopped"
        : outcome === "skipped"
          ? "Nothing to compact"
          : outcome === "failed"
            ? `Compacting failed${detail ? ` · ${clip(detail)}` : ""}`
            : `Compacted${saved ? ` · saved ~${formatTokens(saved)} tokens` : ""}`;
  const summary = state === "done" ? compaction.summary?.trim() : undefined;
  return (
    <div className="chat-compaction" role="note">
      <div className="chat-switch">
        <span className="chat-switch-line" aria-hidden="true" />
        <span
          className={`chat-switch-text${state === "compacting" ? " is-live" : ""}`}
          title={detail && detail.length > DETAIL_MAX ? detail : undefined}
        >
          {text}
        </span>
        {summary ? (
          <button
            type="button"
            className="chat-compaction-toggle"
            aria-expanded={open}
            aria-controls={summaryId}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? "Hide summary" : "Show summary"}
          </button>
        ) : null}
        <span className="chat-switch-line" aria-hidden="true" />
      </div>
      {summary ? (
        <Collapse open={open}>
          <div id={summaryId} className="chat-compaction-summary">
            <Markdown text={summary} />
          </div>
        </Collapse>
      ) : null}
    </div>
  );
}

const DETAIL_MAX = 120;

function clip(text: string): string {
  return text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX - 1)}…` : text;
}
