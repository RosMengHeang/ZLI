import { useBrowserStore } from "../stores/browserStore";

export function BrowserAutomationStatus() {
  const status = useBrowserStore((state) => state.automation);
  if (!status) return null;
  const label = status.phase === "running"
    ? `${status.operation}…`
    : status.phase === "failed"
      ? `${status.operation} failed`
      : `${status.operation} done`;
  return (
    <div
      role="status"
      className={status.phase === "failed" ? "max-w-36 truncate text-[11px] text-danger" : "max-w-36 truncate text-[11px] text-mute"}
    >
      {label}
    </div>
  );
}
