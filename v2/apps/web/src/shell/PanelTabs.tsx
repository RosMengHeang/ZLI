import { type KeyboardEvent, type Ref, useEffect, useRef, useState } from "react";

import { Icon, type IconName } from "../ui/Icon.js";
import type { LauncherItem, LiveTone } from "./launcherItems.js";

export type PanelTab = { id: string; label: string; icon: IconName };

/** The one key that picks a panel while the plus menu is open. */
const HOTKEYS: Record<string, string> = {
  review: "C",
  files: "F",
  terminal: "T",
  browser: "B",
  pullRequest: "P",
  mobile: "M",
};

export function panelHotkey(id: string): string | undefined {
  return HOTKEYS[id];
}

/**
 * The right panel's tab strip: only the panels opened so far, one closable tab each, and a plus that lists every
 * panel with its key and what is going on in it. Files and Terminal each get a slot right after their tab, where
 * their open files and shells show as tabs of their own; while a slot holds tabs, the panel's own tab steps aside.
 */
export function PanelTabs({
  tabs,
  active,
  items,
  shortcutFor,
  slots,
  onMenuChange,
  onSelect,
  onClose,
}: {
  tabs: readonly PanelTab[];
  active: string | undefined;
  items: readonly LauncherItem[];
  /** The app-wide shortcut that opens a panel, for its tooltip. */
  shortcutFor?: ((id: string) => string | undefined) | undefined;
  /** Where a panel puts tabs of its own (open files, shells), by panel id. */
  slots?: Partial<Record<string, Ref<HTMLSpanElement>>> | undefined;
  /** Told when the plus menu opens and closes, so a native view (the browser) can step out from under it. */
  onMenuChange?: ((open: boolean) => void) | undefined;
  onSelect(id: string): void;
  onClose(id: string): void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const addRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // The strip scrolls when it fills; the tab in use stays in sight.
  useEffect(() => {
    if (!active) return;
    listRef.current
      ?.querySelector(".panel-strip-tab.is-active")
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [active]);

  /** Which ends have more tabs past them: the strip fades there and shows an arrow to scroll on. */
  const [clipped, setClipped] = useState({ start: false, end: false });
  // Tabs come and go through the slots too, so the strip is watched, not just this component's tabs.
  useEffect(() => {
    const strip = listRef.current;
    if (!strip) return;
    const mark = () => {
      const start = strip.scrollLeft > 1;
      const end = strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1;
      strip.classList.toggle("is-clipped-start", start);
      strip.classList.toggle("is-clipped-end", end);
      setClipped((current) => (current.start === start && current.end === end ? current : { start, end }));
    };
    mark();
    strip.addEventListener("scroll", mark, { passive: true });
    // A mouse wheel scrolls a full strip sideways. Listened to directly, not passive, so the page does not take it.
    const wheel = (event: WheelEvent) => {
      if (strip.scrollWidth <= strip.clientWidth) return;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (!delta) return;
      event.preventDefault();
      strip.scrollLeft += event.deltaMode === 1 ? delta * 16 : delta;
    };
    strip.addEventListener("wheel", wheel, { passive: false });
    const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(mark);
    resize?.observe(strip);
    const mutation = typeof MutationObserver === "undefined" ? undefined : new MutationObserver(mark);
    mutation?.observe(strip, { childList: true, subtree: true });
    return () => {
      strip.removeEventListener("scroll", mark);
      strip.removeEventListener("wheel", wheel);
      resize?.disconnect();
      mutation?.disconnect();
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: only the menu opening or closing is news.
  useEffect(() => onMenuChange?.(menuOpen), [menuOpen]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a strip that goes away leaves no menu open.
  useEffect(() => () => onMenuChange?.(false), []);

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
      const item = items.find((candidate) => panelHotkey(candidate.id)?.toLowerCase() === event.key.toLowerCase());
      if (!item) return;
      event.preventDefault();
      event.stopPropagation();
      pick(item);
      return;
    } else return;
    event.preventDefault();
    next?.focus();
  };

  /** Scrolls the strip most of its width toward one end, as the arrows do. */
  const scrollStrip = (direction: -1 | 1) => {
    const strip = listRef.current;
    if (!strip) return;
    strip.scrollBy?.({ left: direction * Math.max(80, strip.clientWidth * 0.7), behavior: "smooth" });
  };

  return (
    <div className="panel-strip-wrap">
      {clipped.start ? (
        <button
          type="button"
          className="panel-strip-arrow"
          aria-label="Scroll tabs left"
          data-tooltip="More tabs"
          onClick={() => scrollStrip(-1)}
        >
          <Icon name="chevronLeft" size={13} />
        </button>
      ) : null}
      <div className="panel-strip" role="tablist" aria-label="Panels" aria-orientation="horizontal" ref={listRef}>
        {tabs.map((tab) => {
          const on = tab.id === active;
          const live = items.find((item) => item.id === tab.id);
          const tone: LiveTone | undefined = live?.live?.tone;
          const marked = !on && tone !== undefined && tone !== "muted";
          const shortcut = shortcutFor?.(tab.id);
          return [
            <div
              key={tab.id}
              className={`panel-strip-tab is-${tab.id}${on ? " is-active" : ""}${marked ? ` is-${tone}` : ""}`}
            >
              <button
                type="button"
                role="tab"
                className="panel-strip-pick"
                aria-selected={on}
                aria-label={tab.label}
                aria-description={live?.count ? `${live.count} waiting` : undefined}
                data-tooltip={on ? undefined : tab.label}
                data-shortcut={on ? undefined : shortcut}
                onClick={() => (on ? undefined : onSelect(tab.id))}
                onAuxClick={(event) => {
                  if (event.button === 1) onClose(tab.id);
                }}
              >
                <Icon name={tab.icon} size={14} />
                <span className="panel-strip-label" aria-hidden="true">
                  {tab.label}
                </span>
                {marked ? <span className="panel-strip-dot" aria-hidden="true" /> : null}
              </button>
              <button
                type="button"
                className="panel-strip-close"
                aria-label={`Close ${tab.label}`}
                onClick={() => onClose(tab.id)}
              >
                <Icon name="x" size={11} />
              </button>
            </div>,
            slots?.[tab.id] ? (
              <span
                key={`${tab.id}-slot`}
                className={`panel-strip-slot is-${tab.id}${on ? " is-active" : ""}`}
                ref={slots[tab.id]}
                onClickCapture={(event) => {
                  if (on || !(event.target instanceof Element) || event.target.closest('[class$="-close"]')) return;
                  onSelect(tab.id);
                }}
              />
            ) : null,
          ];
        })}
      </div>
      {clipped.end ? (
        <button
          type="button"
          className="panel-strip-arrow"
          aria-label="Scroll tabs right"
          data-tooltip="More tabs"
          onClick={() => scrollStrip(1)}
        >
          <Icon name="chevronRight" size={13} />
        </button>
      ) : null}
      <div className="panel-strip-add">
        <button
          ref={addRef}
          type="button"
          className="panel-strip-plus"
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
              const key = panelHotkey(item.id);
              return (
                <button
                  key={item.id}
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className={`menu-item panel-menu-item${item.live ? ` is-${item.live.tone}` : ""}`}
                  aria-keyshortcuts={key}
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
                  {key ? <kbd className="panel-menu-key">{key}</kbd> : null}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The right panel before anything is open in it: one tile per panel with its key and one line on what is going on
 * in it. Keys work here too, so a panel opens without the mouse.
 */
export function PanelStart({ items }: { items: readonly LauncherItem[] }) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the keys are a shortcut; every tile is also a button.
    <div
      className="panel-start"
      onKeyDown={(event) => {
        if (event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1) return;
        const item = items.find((candidate) => panelHotkey(candidate.id)?.toLowerCase() === event.key.toLowerCase());
        if (!item) return;
        event.preventDefault();
        item.run();
      }}
    >
      <h3 className="panel-start-title">Open a panel</h3>
      <ul className="panel-start-grid">
        {items.map((item) => {
          const key = panelHotkey(item.id);
          const live = item.live && item.live.tone !== "muted" ? item.live : undefined;
          return (
            <li key={item.id}>
              <button
                type="button"
                className={`panel-start-item${live ? ` is-${live.tone}` : ""}`}
                aria-keyshortcuts={key}
                onClick={item.run}
              >
                <span className="panel-start-head">
                  <span className="panel-start-icon" aria-hidden="true">
                    <Icon name={item.icon} size={15} />
                  </span>
                  <span className="panel-start-name">{item.label}</span>
                  {key ? <kbd className="panel-start-key">{key}</kbd> : null}
                </span>
                <span className="panel-start-detail">{live ? live.text : item.detail}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
