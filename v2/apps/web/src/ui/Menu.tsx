import { type KeyboardEvent, type Ref, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { cx } from "./Button.js";
import { Icon, type IconName } from "./Icon.js";

export type MenuItem = {
  id: string;
  label: string;
  icon?: IconName | undefined;
  disabled?: boolean | undefined;
  run(): void;
};
/** A separator draws a rule between two runs of items. */
export type MenuEntry = MenuItem | "separator";

type Placement = { left: number; maxHeight: number } & ({ top: number } | { bottom: number });

const GAP = 6;
const EDGE = 8;

/**
 * An icon button that opens a short menu of actions. The menu opens above the button when it fits and lines up
 * with its right edge. Arrow keys, Home, and End move between items; Escape, Tab, or a click elsewhere closes it
 * and gives focus back to the button. Focus returns to the button before an item runs, so an item can move it on.
 */
export function MenuButton({
  label,
  icon,
  items,
  tooltip,
  size = "sm",
  iconSize,
  disabled = false,
  ref,
}: {
  /** The button's accessible name, and the menu's. */
  label: string;
  icon: IconName;
  items: readonly MenuEntry[];
  tooltip?: string | undefined;
  size?: "xs" | "sm" | "md";
  iconSize?: number | undefined;
  disabled?: boolean | undefined;
  ref?: Ref<HTMLButtonElement>;
}) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<Placement>();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const focusLastRef = useRef(false);

  const setTrigger = (node: HTMLButtonElement | null) => {
    triggerRef.current = node;
    if (typeof ref === "function") ref(node);
    else if (ref) ref.current = node;
  };

  const close = (returnFocus: boolean) => {
    setOpen(false);
    setPlacement(undefined);
    if (returnFocus) triggerRef.current?.focus();
  };

  useLayoutEffect(() => {
    if (!open) return;
    const anchor = triggerRef.current?.getBoundingClientRect();
    const menu = menuRef.current;
    if (!anchor || !menu) return;
    const above = anchor.top - GAP - EDGE;
    const below = window.innerHeight - anchor.bottom - GAP - EDGE;
    const left = Math.max(EDGE, Math.min(anchor.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - EDGE));
    const up = menu.offsetHeight <= above || above >= below;
    setPlacement(
      up
        ? { left, bottom: window.innerHeight - anchor.top + GAP, maxHeight: above }
        : { left, top: anchor.bottom + GAP, maxHeight: below },
    );
  }, [open]);

  // The menu is measured while hidden, and hidden elements cannot take focus, so focus waits for placement.
  const placed = placement !== undefined;
  useLayoutEffect(() => {
    if (!placed) return;
    const enabled = enabledItems(menuRef.current);
    (focusLastRef.current ? enabled.at(-1) : enabled[0])?.focus({ preventScroll: true });
    focusLastRef.current = false;
  }, [placed]);

  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null) =>
      target instanceof Node && (menuRef.current?.contains(target) || triggerRef.current?.contains(target));
    const onPointerDown = (event: PointerEvent) => {
      if (!inside(event.target)) close(false);
    };
    const onScroll = (event: Event) => {
      if (!inside(event.target)) close(false);
    };
    const onLeave = () => close(false);
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
  });

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const enabled = enabledItems(menuRef.current);
    const index = enabled.indexOf(document.activeElement as HTMLElement);
    let next: HTMLElement | undefined;
    if (event.key === "ArrowDown") next = enabled[(index + 1) % enabled.length];
    else if (event.key === "ArrowUp") next = enabled[(index - 1 + enabled.length) % enabled.length];
    else if (event.key === "Home") next = enabled[0];
    else if (event.key === "End") next = enabled.at(-1);
    else if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    } else return;
    event.preventDefault();
    next?.focus();
  };

  return (
    <>
      <button
        ref={setTrigger}
        type="button"
        className={cx("btn btn-ghost btn-icon", size !== "md" && `btn-${size}`)}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        data-tooltip={open ? undefined : (tooltip ?? label)}
        disabled={disabled}
        onClick={() => (open ? close(false) : setOpen(true))}
        onKeyDown={(event) => {
          if (open || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
          event.preventDefault();
          focusLastRef.current = event.key === "ArrowUp";
          setOpen(true);
        }}
      >
        <Icon name={icon} size={iconSize ?? 14} />
      </button>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              className="picker-menu menu"
              data-side={placement && "top" in placement ? "bottom" : "top"}
              style={
                placement
                  ? { ...placement, maxHeight: Math.max(120, placement.maxHeight) }
                  : { left: 0, top: 0, visibility: "hidden" }
              }
            >
              <div className="picker-list" id={menuId} role="menu" aria-label={label} onKeyDown={onMenuKeyDown}>
                {items.map((entry, index) =>
                  entry === "separator" ? (
                    // biome-ignore lint/suspicious/noArrayIndexKey: separators have no identity beyond their place.
                    <hr key={`separator-${index}`} className="menu-separator" />
                  ) : (
                    <button
                      key={entry.id}
                      type="button"
                      role="menuitem"
                      tabIndex={-1}
                      className="menu-item"
                      aria-disabled={entry.disabled || undefined}
                      onPointerMove={(event) => {
                        if (!entry.disabled && document.activeElement !== event.currentTarget)
                          event.currentTarget.focus({ preventScroll: true });
                      }}
                      onClick={() => {
                        if (entry.disabled) return;
                        close(true);
                        entry.run();
                      }}
                    >
                      {entry.icon ? <Icon name={entry.icon} size={14} /> : null}
                      <span className="menu-item-label">{entry.label}</span>
                    </button>
                  ),
                )}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function enabledItems(menu: HTMLElement | null): HTMLElement[] {
  return [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? [])];
}
