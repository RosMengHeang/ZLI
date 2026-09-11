import { useBrowserStore } from "../stores/browserStore";
import { useUiStore } from "../stores/uiStore";

export function BrowserControlStatus() {
  const status = useBrowserStore((state) => state.controlStatus);
  const setPreferencesOpen = useUiStore((state) => state.setPreferencesOpen);
  if (!status) return null;
  const enabled = status.bridgeAvailable && status.enabled;
  const label = status.bridgeAvailable
    ? (enabled ? "Browser control on" : "Browser control off")
    : "Browser unavailable";
  if (!enabled) {
    return (
      <button
        type="button"
        aria-label="Open browser control preferences"
        title="Open browser control preferences"
        onClick={() => setPreferencesOpen(true)}
        className="hidden items-center gap-1.5 text-[11px] text-mute outline-none hover:text-paper focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-accent sm:flex"
      >
        <span className="h-1.5 w-1.5 rounded-sm bg-mute" aria-hidden="true" />
        <span>{label}</span>
      </button>
    );
  }
  return (
    <div
      role="status"
      title="Built-in browser control is enabled"
      className="hidden items-center gap-1.5 text-[11px] text-mute sm:flex"
    >
      <span className="h-1.5 w-1.5 rounded-sm bg-emerald-500" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
