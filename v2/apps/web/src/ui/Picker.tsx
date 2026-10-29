import { type KeyboardEvent, type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { scrollMovesAnchor } from "./anchoredScroll.js";
import { Icon } from "./Icon.js";

export type PickerOption<T extends string> = {
  value: T;
  label: string;
  description?: string | undefined;
  icon?: ReactNode;
  /**
   * A heading the option sits under. Options sharing a group show together, in the order each group first
   * appears; an option without one, when others have one, sits in an unlabelled section of its own.
   */
  group?: string | undefined;
};

type Placement = { left: number; maxHeight: number; minWidth: number } & ({ top: number } | { bottom: number });

const GAP = 6;
const EDGE = 8;

/**
 * A trigger that opens a dark list of choices. It replaces native selects, whose option lists follow
 * the operating system's light theme. The ghost variant sits in toolbars and opens upward when it fits;
 * the field variant sits in forms, looks like a text field, and opens downward like a select. Arrow keys, Home, End, and typing a
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
  variant = "ghost",
  id,
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
  variant?: "ghost" | "field";
  /** Lets a form label point at the trigger. */
  id?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<Placement>();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const current = options.find((option) => option.value === value);
  const withIcons = options.some((option) => option.icon !== undefined);
  const sections = optionSections(options);

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
    const minWidth = variant === "field" ? anchor.width : 0;
    const width = Math.max(menu.offsetWidth, minWidth);
    const left = Math.max(EDGE, Math.min(anchor.left, window.innerWidth - width - EDGE));
    const height = menu.offsetHeight;
    const up = variant === "field" ? height > below && above > below : height <= above || above >= below;
    setPlacement(
      up
        ? { left, minWidth, bottom: window.innerHeight - anchor.top + GAP, maxHeight: above }
        : { left, minWidth, top: anchor.bottom + GAP, maxHeight: below },
    );
  }, [open, variant]);

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
      if (scrollMovesAnchor(event, triggerRef.current)) close(false);
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

  const renderOption = (option: PickerOption<T>) => {
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
          if (document.activeElement !== event.currentTarget) event.currentTarget.focus({ preventScroll: true });
        }}
        onClick={() => pick(option.value)}
      >
        {withIcons ? (
          <span className="picker-option-icon" aria-hidden="true">
            {option.icon}
          </span>
        ) : null}
        <span className="picker-option-text">
          <span className="picker-option-label">{option.label}</span>
          {option.description ? <span className="picker-option-description">{option.description}</span> : null}
        </span>
        <span className="picker-option-check" aria-hidden="true">
          {selected ? <Icon name="check" size={14} /> : null}
        </span>
      </button>
    );
  };

  return (
    <>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className={`${variant === "field" ? "select picker-field" : "select-ghost"} picker-trigger${disabled ? " is-disabled" : ""}${className ? ` ${className}` : ""}`}
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
                {sections
                  ? sections.map((section, index) => {
                      const labelId = `${listId}-group-${index}`;
                      return (
                        // biome-ignore lint/a11y/useSemanticElements: a listbox groups its options with role="group"; a fieldset is for form fields.
                        <div
                          key={section.group ?? `section-${index}`}
                          className="picker-group"
                          role="group"
                          aria-labelledby={section.group ? labelId : undefined}
                        >
                          {section.group ? (
                            <div className="picker-group-label" id={labelId} role="presentation">
                              {section.group}
                            </div>
                          ) : null}
                          {section.options.map(renderOption)}
                        </div>
                      );
                    })
                  : options.map(renderOption)}
              </div>
              {footer ? <div className="picker-footer">{footer}</div> : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

type Section<T extends string> = { group: string | undefined; options: PickerOption<T>[] };

/** The options in their sections, or undefined when no option names a group. */
function optionSections<T extends string>(options: readonly PickerOption<T>[]): Section<T>[] | undefined {
  if (!options.some((option) => option.group !== undefined)) return undefined;
  const sections: Section<T>[] = [];
  for (const option of options) {
    const section = sections.find((candidate) => candidate.group === option.group);
    if (section) section.options.push(option);
    else sections.push({ group: option.group, options: [option] });
  }
  return sections;
}
