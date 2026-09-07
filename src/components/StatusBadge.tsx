import type { AgentStatus, SessionStatus } from "../types";
import {
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

export function StatusBadge({ status }: { status: AgentStatus | SessionStatus }) {
  const presentation = statusPresentation(presentedStatus(status));

  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[11px] font-medium ${TONE_STYLES[presentation.tone]}`}
      aria-label={`Status: ${presentation.label}`}
    >
      <span
        className="status-dot"
        data-tone={presentation.tone}
        data-animated={presentation.animated}
        aria-hidden="true"
      />
      {presentation.label}
    </span>
  );
}
