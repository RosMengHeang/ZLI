import type { AgentStatus, SessionStatus } from "../types";

const STYLES: Record<string, string> = {
  starting: "text-[#cca700]",
  running: "text-[#89d185]",
  exited: "text-[#8b8b8b]",
  killed: "text-[#8b8b8b]",
  failed: "text-[#f14c4c]",
  error: "text-[#f14c4c]",
};

export function StatusBadge({ status }: { status: AgentStatus | SessionStatus }) {
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] ${STYLES[status] ?? "text-[#8b8b8b]"}`}>
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-current" />
      {status}
    </span>
  );
}
