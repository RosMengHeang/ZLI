import type { AgentStatus, SessionStatus } from "../types";

const STYLES: Record<string, string> = {
  starting: "text-warn",
  running: "text-ok",
  exited: "text-mute",
  killed: "text-mute",
  failed: "text-danger",
  error: "text-danger",
};

const LABELS: Record<string, string> = {
  starting: "Starting",
  running: "Running",
  exited: "Exited",
  killed: "Stopped",
  failed: "Failed",
  error: "Error",
};

export function StatusBadge({ status }: { status: AgentStatus | SessionStatus }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] font-medium ${STYLES[status] ?? "text-mute"}`}>
      <span className="relative inline-flex h-1.5 w-1.5">
        {status === "running" || status === "starting" ? (
          <span className="absolute inset-0 animate-ping rounded-full bg-current opacity-40" />
        ) : null}
        <span className="relative inline-block h-1.5 w-1.5 rounded-full bg-current" />
      </span>
      {LABELS[status] ?? status}
    </span>
  );
}
