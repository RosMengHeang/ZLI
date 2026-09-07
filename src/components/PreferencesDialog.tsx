import type { ThemeMode } from "../lib/theme";
import { useUiStore } from "../stores/uiStore";
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
    </Modal>
  );
}
