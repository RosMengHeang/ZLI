import { type KeyboardEvent, type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Icon } from "./Icon.js";

export type PickerOption<T extends string> = {
  value: T;
  label: string;
  description?: string | undefined;
  icon?: ReactNode;
};

type Placement = { left: number; maxHeight: number } & ({ top: number } | { bottom: number });

const GAP = 6;
const EDGE = 8;

/**
 * A compact trigger that opens a dark list of choices above or below it. It replaces native selects,
 * whose option lists follow the operating system's light theme. Arrow keys, Home, End, and typing a
 * letter move through the options; Enter picks one; Escape, Tab, or a click elsewhere closes the list.
 */
export function Picker<T extends string>({
  label,
  value,
  options,
  onChange,
  children,
  tooltip,
  disabled = false,
  className,
  footer,
}: {
  /** Names the trigger and the list for assistive technology. */
  label: string;
  value: T;
  options: readonly PickerOption<T>[];
  onChange(value: T): void;
  /** What the closed trigger shows. */
  children: ReactNode;
  tooltip?: string | undefined;
  /** The trigger stays focusable so its tooltip can explain why it is locked. */
  disabled?: boolean;
  className?: string | undefined;
  footer?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<Placement>();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const current = options.find((option) => option.value === value);

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
    const left = Math.max(EDGE, Math.min(anchor.left, window.innerWidth - menu.offsetWidth - EDGE));
    setPlacement(
      menu.offsetHeight <= above || above >= below
        ? { left, bottom: window.innerHeight - anchor.top + GAP, maxHeight: above }
        : { left, top: anchor.bottom + GAP, maxHeight: below },
    );
  }, [open]);

  // The list is measured while hidden, and hidden elements cannot take focus, so focus waits for placement.
  const placed = placement !== undefined;
  useLayoutEffect(() => {
    if (!placed) return;
    const menu = menuRef.current;
    const selected =
      menu?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]') ??
      menu?.querySelector<HTMLElement>('[role="option"]');
    selected?.focus({ preventScroll: true });
    selected?.scrollIntoView?.({ block: "nearest" });
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

  const pick = (next: T) => {
    close(true);
    if (next !== value) onChange(next);
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    let next: HTMLElement | undefined;
    if (event.key === "ArrowDown") next = items[(index + 1) % items.length];
    else if (event.key === "ArrowUp") next = items[(index - 1 + items.length) % items.length];
    else if (event.key === "Home") next = items[0];
    else if (event.key === "End") next = items.at(-1);
    else if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    } else if (event.key.length === 1 && /\S/u.test(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const key = event.key.toLowerCase();
      const ordered = [...items.slice(index + 1), ...items.slice(0, index + 1)];
      next = ordered.find((item) => item.dataset.label?.toLowerCase().startsWith(key));
      if (!next) return;
    } else return;
    event.preventDefault();
    next?.focus();
    next?.scrollIntoView?.({ block: "nearest" });
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`select-ghost picker-trigger${disabled ? " is-disabled" : ""}${className ? ` ${className}` : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`${label}: ${current?.label ?? value}`}
        aria-disabled={disabled || undefined}
        data-tooltip={open ? undefined : tooltip}
        onClick={() => {
          if (disabled) return;
          if (open) close(false);
          else setOpen(true);
        }}
        onKeyDown={(event) => {
          if (disabled || open || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
          event.preventDefault();
          setOpen(true);
        }}
      >
        {children}
        <Icon name="chevronDown" size={12} className="picker-chevron" />
      </button>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              className="picker-menu"
              data-side={placement && "top" in placement ? "bottom" : "top"}
              style={
                placement
                  ? { ...placement, maxHeight: Math.max(120, placement.maxHeight) }
                  : { left: 0, top: 0, visibility: "hidden" }
              }
            >
              <div className="picker-list" id={listId} role="listbox" aria-label={label} onKeyDown={onMenuKeyDown}>
                {options.map((option) => {
                  const selected = option.value === value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      tabIndex={-1}
                      className="picker-option"
                      data-label={option.label}
                      onPointerMove={(event) => {
                        if (document.activeElement !== event.currentTarget)
                          event.currentTarget.focus({ preventScroll: true });
                      }}
                      onClick={() => pick(option.value)}
                    >
                      {option.icon ? (
                        <span className="picker-option-icon" aria-hidden="true">
                          {option.icon}
                        </span>
                      ) : null}
                      <span className="picker-option-text">
                        <span className="picker-option-label">{option.label}</span>
                        {option.description ? (
                          <span className="picker-option-description">{option.description}</span>
                        ) : null}
                      </span>
                      <span className="picker-option-check" aria-hidden="true">
                        {selected ? <Icon name="check" size={14} /> : null}
                      </span>
                    </button>
                  );
                })}
              </div>
              {footer ? <div className="picker-footer">{footer}</div> : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
