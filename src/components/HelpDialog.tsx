import { Modal } from "./Modal";
import { APP_SHORTCUTS } from "../lib/platform";
import { useUiStore } from "../stores/uiStore";

const SHORTCUTS = [
  { label: "Open project", keys: APP_SHORTCUTS.openProject },
  { label: "Add agent", keys: APP_SHORTCUTS.addAgent },
  { label: "Add terminal", keys: APP_SHORTCUTS.addTerminal },
  { label: "Toggle Git review", keys: APP_SHORTCUTS.toggleGit },
  { label: "Toggle browser", keys: APP_SHORTCUTS.toggleBrowser },
];

export function HelpDialog() {
  const open = useUiStore((s) => s.helpOpen);
  const setOpen = useUiStore((s) => s.setHelpOpen);

  return (
    <Modal title="Help" description="Keyboard shortcuts for your workspace." open={open} onClose={() => setOpen(false)} width={420}>
      <div className="flex flex-col gap-3">
        <p className="text-[13px] leading-5 text-mute">
          ZLI stays on this machine. Shortcuts below match the current workspace.
        </p>
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
          {SHORTCUTS.map((item) => (
            <li key={item.label} className="flex items-center justify-between gap-3 px-3 py-2">
              <span className="text-[13px] text-paper">{item.label}</span>
              <kbd className="rounded-md border border-line bg-ink px-1.5 py-0.5 font-mono text-[11px] text-mute">
                {item.keys}
              </kbd>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}
