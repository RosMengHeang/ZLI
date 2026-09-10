import type { AgentStatus, SessionStatus } from "../types";
import type { AttentionStatus } from "../lib/agentEvents.ts";
import {
  attentionStatusPresentation,
  statusPresentation,
  type PresentedStatus,
  type StatusTone,
} from "../lib/statusPresentation";

const TONE_STYLES: Record<StatusTone, string> = {
  success: "text-ok",
  warning: "text-warn",
  danger: "text-danger",
  neutral: "text-mute",
};

function presentedStatus(status: AgentStatus | SessionStatus): PresentedStatus {
  switch (status) {
    case "running":
    case "starting":
    case "failed":
      return status;
    case "error":
      return "failed";
    case "exited":
    case "killed":
      return "stopped";
  }
}

export function StatusBadge({
  status,
  attentionStatus,
  unread = false,
  compact = false,
}: {
  status: AgentStatus | SessionStatus;
  attentionStatus?: AttentionStatus;
  unread?: boolean;
  compact?: boolean;
}) {
  const execution = statusPresentation(presentedStatus(status));
  const presentation = attentionStatus ? attentionStatusPresentation(attentionStatus) : execution;
  const accessibleLabel = attentionStatus
    ? `Attention: ${presentation.label}. Execution: ${execution.label}${unread ? ". Unread" : ""}`
    : `Status: ${presentation.label}`;

  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[11px] font-medium ${TONE_STYLES[presentation.tone]}`}
      aria-label={accessibleLabel}
    >
      <span
        className="status-dot"
        data-tone={presentation.tone}
        data-unread={unread}
        data-animated={presentation.animated}
        aria-hidden="true"
      />
      {compact ? <span className="sr-only">{presentation.label}</span> : presentation.label}
    </span>
  );
}
