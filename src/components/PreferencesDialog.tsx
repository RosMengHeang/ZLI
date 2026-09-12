import { useEffect } from "react";
import type { ThemeMode } from "../lib/theme";
import { useUiStore } from "../stores/uiStore";
import { useBrowserStore } from "../stores/browserStore";
import { Modal } from "./Modal";

const THEME_OPTIONS: Array<{ mode: ThemeMode; label: string; description: string }> = [
  { mode: "system", label: "System", description: "Match Windows appearance." },
  { mode: "light", label: "Light", description: "Use light appearance." },
  { mode: "dark", label: "Dark", description: "Use dark appearance." },
];

export function PreferencesDialog() {
  const open = useUiStore((state) => state.preferencesOpen);
  const setOpen = useUiStore((state) => state.setPreferencesOpen);
  const themeMode = useUiStore((state) => state.themeMode);
  const setThemeMode = useUiStore((state) => state.setThemeMode);
  const browserControl = useBrowserStore((state) => state.controlStatus);
  const browserControlLoading = useBrowserStore((state) => state.controlLoading);
  const browserControlError = useBrowserStore((state) => state.error);
  const refreshControlStatus = useBrowserStore((state) => state.refreshControlStatus);
  const setControlEnabled = useBrowserStore((state) => state.setControlEnabled);

  useEffect(() => {
    if (open && !browserControl) void refreshControlStatus();
  }, [browserControl, open, refreshControlStatus]);

  return (
    <Modal title="Preferences" open={open} onClose={() => setOpen(false)} width={420}>
      <div role="radiogroup" aria-label="Appearance" className="flex flex-col gap-2">
        {THEME_OPTIONS.map(({ mode, label, description }) => (
          <label
            key={mode}
            className="flex cursor-pointer items-center gap-3 rounded-xl border border-line bg-ink px-3 py-2.5"
          >
            <input
              type="radio"
              name="theme-mode"
              value={mode}
              checked={themeMode === mode}
              onChange={() => setThemeMode(mode)}
            />
            <span>
              <span className="block text-[13px] font-medium text-paper">{label}</span>
              <span className="block text-[11px] text-mute">{description}</span>
            </span>
          </label>
        ))}
      </div>
      <div className="mt-5 border-t border-line pt-4">
        <label className="flex cursor-pointer items-start justify-between gap-4 rounded-xl border border-line bg-ink px-3 py-3">
          <span>
            <span className="block text-[13px] font-medium text-paper">Built-in browser control</span>
            <span className="mt-1 block text-[11px] leading-5 text-mute">Allow managed agents to inspect and control the isolated ZLI browser.</span>
          </span>
          <input
            type="checkbox"
            aria-label="Built-in browser control"
            checked={browserControl?.enabled ?? false}
            disabled={browserControlLoading || browserControl?.bridgeAvailable === false}
            onChange={(event) => void setControlEnabled(event.target.checked)}
            className="mt-0.5 h-4 w-4 accent-[var(--accent)]"
          />
        </label>
        {browserControl?.bridgeAvailable === false ? (
          <p className="mt-2 text-[11px] text-mute">Start the desktop runtime to change this setting.</p>
        ) : null}
        {browserControlError ? <p role="alert" className="mt-2 text-[11px] text-danger">{browserControlError}</p> : null}
      </div>
    </Modal>
  );
}
