import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { scrollMovesAnchor, useAnchoredPlacement } from "./anchoredPopup.js";
import { Icon, type IconName } from "./Icon.js";

export type SearchListItem = {
  id: string;
  label: string;
  icon?: IconName | undefined;
  /** A second, dimmer line, such as where a branch is checked out. */
  detail?: string | undefined;
  checked?: boolean | undefined;
  disabled?: boolean | undefined;
  /** Why the item is disabled. */
  title?: string | undefined;
};

export type SearchListAction = { id: string; label: string; icon: IconName; run(): void };

/**
 * A dropdown for long lists, such as branches: a filter on top, a list of fixed height that scrolls, and
 * actions pinned under it. Typing filters; the arrow keys move through what is left and Enter picks.
 */
export function SearchList({
  anchorRef,
  label,
  placeholder,
  items,
  actions = [],
  status,
  onPick,
  onClose,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  label: string;
  placeholder: string;
  items: readonly SearchListItem[];
  actions?: readonly SearchListAction[];
  /** Shown in place of the list, such as while it loads. */
  status?: ReactNode;
  onPick(id: string): void;
  onClose(returnFocus: boolean): void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const popupRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const placement = useAnchoredPlacement(true, anchorRef, popupRef, {
    prefer: "below",
    align: "start",
    gap: 4,
    edge: 8,
    matchWidth: true,
  });

  const needle = query.trim().toLowerCase();
  const shown = needle ? items.filter((item) => item.label.toLowerCase().includes(needle)) : items;
  const enabled = shown.filter((item) => !item.disabled);
  const current = enabled[Math.min(active, enabled.length - 1)];

  const placed = placement !== undefined;
  useLayoutEffect(() => {
    if (placed) inputRef.current?.focus({ preventScroll: true });
  }, [placed]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new filter starts again from the top.
  useEffect(() => setActive(0), [needle]);

  useEffect(() => {
    const id = current?.id;
    if (!id) return;
    const row = [...(listRef.current?.children ?? [])].find(
      (child): child is HTMLElement => child instanceof HTMLElement && child.dataset.id === id,
    );
    row?.scrollIntoView?.({ block: "nearest" });
  }, [current?.id]);

  useEffect(() => {
    const inside = (target: EventTarget | null) =>
      target instanceof Node && (popupRef.current?.contains(target) || anchorRef.current?.contains(target));
    const onPointerDown = (event: PointerEvent) => {
      if (!inside(event.target)) onClose(false);
    };
    const onScroll = (event: Event) => {
      if (!popupRef.current?.contains(event.target as Node) && scrollMovesAnchor(event, anchorRef.current))
        onClose(false);
    };
    const onLeave = () => onClose(false);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onLeave);
    window.addEventListener("blur", onLeave);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onLeave);
      window.removeEventListener("blur", onLeave);
    };
  }, [anchorRef, onClose]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      onClose(true);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => (enabled.length === 0 ? 0 : (index + 1) % enabled.length));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => (enabled.length === 0 ? 0 : (index - 1 + enabled.length) % enabled.length));
    } else if (event.key === "Enter" && current) {
      event.preventDefault();
      onPick(current.id);
    }
  };

  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: the keys move through the list while the filter keeps focus.
    <div
      ref={popupRef}
      className="search-list"
      style={
        placement
          ? { ...placement, maxHeight: undefined, minWidth: Math.max(240, placement.minWidth ?? 0) }
          : { left: 0, top: 0, visibility: "hidden" }
      }
      onKeyDown={onKeyDown}
    >
      <div className="search-list-filter">
        <Icon name="search" size={13} />
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded="true"
          aria-controls="search-list-options"
          aria-activedescendant={current ? `search-list-${current.id}` : undefined}
          aria-label={placeholder}
          placeholder={placeholder}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div ref={listRef} className="search-list-items" role="listbox" id="search-list-options" aria-label={label}>
        {status ? (
          <p className="search-list-empty">{status}</p>
        ) : shown.length === 0 ? (
          <p className="search-list-empty">Nothing matches “{query.trim()}”.</p>
        ) : (
          shown.map((item) => (
            <div
              key={item.id}
              id={`search-list-${item.id}`}
              data-id={item.id}
              role="option"
              tabIndex={-1}
              aria-selected={item.checked === true}
              aria-disabled={item.disabled || undefined}
              title={item.title}
              className={`search-list-item${item === current ? " is-active" : ""}`}
              onPointerMove={() => {
                const index = enabled.indexOf(item);
                if (index >= 0 && index !== active) setActive(index);
              }}
              onClick={() => {
                if (!item.disabled) onPick(item.id);
              }}
              onKeyDown={() => undefined}
            >
              {item.icon ? <Icon name={item.icon} size={14} /> : null}
              <span className="search-list-text">
                <span className="search-list-label">{item.label}</span>
                {item.detail ? <span className="search-list-detail">{item.detail}</span> : null}
              </span>
              {item.checked ? <Icon name="check" size={14} className="search-list-check" /> : null}
            </div>
          ))
        )}
      </div>
      {actions.length > 0 ? (
        <div className="search-list-actions">
          {actions.map((action) => (
            <button key={action.id} type="button" className="search-list-action" onClick={action.run}>
              <Icon name={action.icon} size={13} />
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
