import { useEffect, useRef } from "react";

import { Icon, type IconName } from "../ui/Icon.js";
import type { LauncherItem } from "./PanelLauncher.js";

export type PanelTab = { id: string; label: string; icon: IconName };

/**
 * The right panel's header: one icon for every panel, always in the same order, so what there is and how much is
 * waiting in it shows at a glance. The open panel shows its name; the others show a count when they have one.
 * A panel opened another way (a pull request, a side chat) joins the strip while it is open.
 */
export function PanelTabs({
  tabs,
  active,
  items,
  onSelect,
}: {
  tabs: readonly PanelTab[];
  active: string | undefined;
  items: readonly LauncherItem[];
  onSelect(id: string): void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active) return;
    listRef.current
      ?.querySelector(".panel-strip-tab.is-active")
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [active]);

  const extra = tabs.filter((tab) => !items.some((item) => item.id === tab.id));
  const entries: { id: string; label: string; icon: IconName; hotkey?: string; count?: number; run(): void }[] = [
    ...items.map((item) => ({
      id: item.id,
      label: item.label,
      icon: item.icon,
      hotkey: item.hotkey,
      ...(item.count ? { count: item.count } : {}),
      run: item.run,
    })),
    ...extra.map((tab) => ({ ...tab, run: () => onSelect(tab.id) })),
  ];

  return (
    <div className="panel-tabs">
      <div className="panel-strip" role="tablist" aria-label="Panels" ref={listRef}>
        {entries.map((entry) => {
          const on = entry.id === active;
          return (
            <button
              key={entry.id}
              type="button"
              role="tab"
              className={`panel-strip-tab${on ? " is-active" : ""}`}
              aria-selected={on}
              aria-label={entry.label}
              aria-description={entry.count ? `${entry.count} waiting` : undefined}
              data-tooltip={
                on ? undefined : entry.hotkey ? `${entry.label} · ${entry.hotkey.toUpperCase()}` : entry.label
              }
              onClick={() => (on ? undefined : entry.run())}
            >
              <Icon name={entry.icon} size={15} />
              {on ? <span className="panel-strip-label">{entry.label}</span> : null}
              {entry.count ? (
                <span className="panel-strip-count" aria-hidden="true">
                  {entry.count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
