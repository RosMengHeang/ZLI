import { type ReactNode, useEffect } from "react";

import { Icon, type IconName } from "../ui/Icon.js";

/** How a panel's live line reads: the colour of its dot says whether it wants a look. */
export type LiveTone = "accent" | "green" | "red" | "muted";

export type LauncherItem = {
  id: string;
  label: string;
  /** What the panel is for, shown when nothing is happening in it. */
  detail: string;
  icon: IconName;
  /** One letter that opens it while the picker is showing. */
  hotkey: string;
  /** What is going on in the panel right now, in place of the detail: changes waiting, a server up, checks failing. */
  live?: { text: ReactNode; tone: LiveTone } | undefined;
  run(): void;
};

/**
 * The right panel before a panel is chosen. Not a menu of names: each row says what is happening in that panel
 * right now for this worktree, so the picker doubles as a glance at the work, and a dot marks the rows that have
 * something in them. The order never moves, so the keys stay where the hand expects them.
 */
export function PanelLauncher({
  title,
  items,
  onClose,
}: {
  /** The worktree's branch, or the project, the panels belong to. */
  title: string | undefined;
  items: readonly LauncherItem[];
  onClose(): void;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest("input, textarea, select, [contenteditable='true'], [role='dialog'], [role='menu']")
      )
        return;
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      const item = items.find((candidate) => candidate.hotkey.toLowerCase() === event.key.toLowerCase());
      if (!item) return;
      event.preventDefault();
      item.run();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [items, onClose]);

  const busy = items.filter((item) => item.live && item.live.tone !== "muted").length;
  return (
    <section className="panel-launcher" aria-labelledby="panel-launcher-title">
      <header className="panel-launcher-head">
        <h2 id="panel-launcher-title">{title ?? "Panels"}</h2>
        <p>
          {busy === 0
            ? "Nothing waiting. Pick a panel, or press its key."
            : busy === 1
              ? "1 panel needs a look."
              : `${busy} panels need a look.`}
        </p>
      </header>
      <ul className="panel-launcher-list">
        {items.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              className={`panel-launcher-item${item.live ? ` is-${item.live.tone}` : ""}`}
              aria-keyshortcuts={item.hotkey.toUpperCase()}
              onClick={item.run}
            >
              <span className="panel-launcher-icon" aria-hidden="true">
                <Icon name={item.icon} size={15} />
              </span>
              <span className="panel-launcher-copy">
                <span className="panel-launcher-label">{item.label}</span>
                <span className="panel-launcher-detail">{item.live?.text ?? item.detail}</span>
              </span>
              <kbd className="panel-launcher-key">{item.hotkey.toUpperCase()}</kbd>
            </button>
          </li>
        ))}
      </ul>
      <p className="panel-launcher-foot">
        <kbd>Esc</kbd> closes
      </p>
    </section>
  );
}
