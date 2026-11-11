import { type KeyboardEvent, useEffect, useRef, useState } from "react";

import { Icon, type IconName } from "../ui/Icon.js";
import type { LauncherItem } from "./PanelLauncher.js";

export type PanelTab = { id: string; label: string; icon: IconName };

/**
 * The right panel's tab strip: the panels opened so far, one tab each, and a plus that lists every panel with its
 * key. The list carries the same live lines as the picker, so adding a panel still says what is going on in it.
 */
export function PanelTabs({
  tabs,
  active,
  items,
  onSelect,
  onClose,
}: {
  tabs: readonly PanelTab[];
  active: string | undefined;
  items: readonly LauncherItem[];
  onSelect(id: string): void;
  onClose(id: string): void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const addRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const close = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (menuRef.current?.contains(event.target) || addRef.current?.contains(event.target)) return;
      setMenuOpen(false);
    };
    document.addEventListener("pointerdown", close, true);
    return () => document.removeEventListener("pointerdown", close, true);
  }, [menuOpen]);

  const pick = (item: LauncherItem) => {
    setMenuOpen(false);
    item.run();
  };
  const dismiss = () => {
    setMenuOpen(false);
    addRef.current?.focus();
  };
  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLElement);
    let next: HTMLElement | undefined;
    if (event.key === "ArrowDown") next = buttons[(index + 1) % buttons.length];
    else if (event.key === "ArrowUp") next = buttons[(index - 1 + buttons.length) % buttons.length];
    else if (event.key === "Home") next = buttons[0];
    else if (event.key === "End") next = buttons.at(-1);
    else if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
      return;
    } else if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1) {
      const item = items.find((candidate) => candidate.hotkey.toLowerCase() === event.key.toLowerCase());
      if (!item) return;
      event.preventDefault();
      event.stopPropagation();
      pick(item);
      return;
    } else return;
    event.preventDefault();
    next?.focus();
  };

  return (
    <div className="panel-tabs">
      <div className="panel-tabs-list" role="tablist" aria-label="Open panels">
        {tabs.map((tab) => (
          <div key={tab.id} className={`panel-tab${tab.id === active ? " is-active" : ""}`}>
            <button
              type="button"
              role="tab"
              className="panel-tab-name"
              aria-selected={tab.id === active}
              onClick={() => onSelect(tab.id)}
              onAuxClick={(event) => {
                if (event.button === 1) onClose(tab.id);
              }}
            >
              <Icon name={tab.icon} size={13} />
              <span>{tab.label}</span>
            </button>
            <button
              type="button"
              className="panel-tab-close"
              aria-label={`Close ${tab.label}`}
              onClick={() => onClose(tab.id)}
            >
              <Icon name="x" size={11} />
            </button>
          </div>
        ))}
      </div>
      <div className="panel-tabs-add">
        <button
          ref={addRef}
          type="button"
          className="panel-tabs-plus"
          aria-label="Add a panel"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          data-tooltip={menuOpen ? undefined : "Add a panel"}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <Icon name="plus" size={14} />
        </button>
        {menuOpen ? (
          <div ref={menuRef} className="menu panel-menu" role="menu" aria-label="Add a panel" onKeyDown={onMenuKeyDown}>
            {items.map((item) => {
              const open = tabs.some((tab) => tab.id === item.id);
              return (
                <button
                  key={item.id}
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className={`menu-item panel-menu-item${item.live ? ` is-${item.live.tone}` : ""}`}
                  aria-keyshortcuts={item.hotkey.toUpperCase()}
                  onClick={() => pick(item)}
                >
                  <span className="panel-menu-icon" aria-hidden="true">
                    <Icon name={item.icon} size={14} />
                  </span>
                  <span className="menu-item-label">{item.label}</span>
                  {item.live && item.live.tone !== "muted" ? (
                    <span className="panel-menu-live">{item.live.text}</span>
                  ) : open ? (
                    <span className="panel-menu-live">Open</span>
                  ) : null}
                  <kbd className="panel-menu-key">{item.hotkey.toUpperCase()}</kbd>
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}
