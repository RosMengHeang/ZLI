import {
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { scrollMovesAnchor, useAnchoredPlacement } from "./anchoredPopup.js";
import { type ButtonVariant, cx } from "./Button.js";
import { Icon, type IconName } from "./Icon.js";
import { ariaShortcut, shortcutText } from "./shortcuts.js";

/** An item in the anchored menu used by the phone controls. */
export type MenuEntry =
  | {
      id: string;
      label: string;
      icon?: IconName | undefined;
      disabled?: boolean | undefined;
      /** Makes the item an on and off setting, shown with a check while it is on. */
      checked?: boolean | undefined;
      /** A second, dimmer line under the label, such as when and how the item last ran. */
      detail?: string | undefined;
      /** Why the item is disabled, or what it does. */
      title?: string | undefined;
      run(): void;
    }
  | "separator";

export type MenuAction = {
  /** Tells items apart when two can share a label. */
  id?: string | undefined;
  label: string;
  icon?: IconName | undefined;
  /** Drawn in place of the icon, such as an app's logo. */
  media?: ReactNode;
  shortcut?: string | undefined;
  disabled?: boolean | undefined;
  /** Why the item is disabled, or what it does. */
  title?: string | undefined;
  tone?: "danger" | undefined;
  /** Makes the item an on and off choice, shown with a check while it is on. */
  checked?: boolean | undefined;
  run(): void;
};
/** A separator draws a rule between two runs of items. */
export type MenuItem = MenuAction | { separator: true };
export type MenuRequest = {
  x: number;
  y: number;
  label: string;
  items: MenuItem[];
  /** `end` lines the menu's right edge up with x, for menus opened from a button. */
  align?: "start" | "end" | undefined;
  /** The button that opened the menu: clicks on it toggle the menu instead of closing it. */
  anchor?: HTMLElement | undefined;
};

const EDGE = 4;
const GAP = 4;
const ANCHORED_GAP = 6;
const ENABLED = ':is([role="menuitem"], [role="menuitemcheckbox"]):not([aria-disabled="true"])';

function isAction(item: MenuItem): item is MenuAction {
  return !("separator" in item);
}

/** A popup menu. Arrow keys move between items; Escape, a click elsewhere, or scrolling closes it. */
export function Menu({ request, onClose }: { request: MenuRequest; onClose(): void }) {
  const menuRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const [position, setPosition] = useState({ left: request.x, top: request.y });

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    const left = request.align === "end" ? request.x - rect.width : request.x;
    // A button near the bottom of the window opens its menu upward rather than over itself.
    const anchor = request.anchor?.getBoundingClientRect();
    const top =
      anchor && request.y + rect.height > window.innerHeight - EDGE ? anchor.top - rect.height - GAP : request.y;
    setPosition({
      left: Math.max(EDGE, Math.min(left, window.innerWidth - rect.width - EDGE)),
      top: Math.max(EDGE, Math.min(top, window.innerHeight - rect.height - EDGE)),
    });
    menu.querySelector<HTMLElement>(ENABLED)?.focus();
  }, [request]);

  useEffect(() => {
    const close = (event: Event) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      if (event.type === "pointerdown" && event.target instanceof Node && request.anchor?.contains(event.target))
        return;
      if (event.type === "scroll" && !scrollMovesAnchor(event, request.anchor)) return;
      onClose();
    };
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("scroll", close, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("scroll", close, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [onClose, request.anchor]);

  const dismiss = () => {
    onClose();
    returnFocus.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>(ENABLED) ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    let next: HTMLElement | undefined;
    if (event.key === "ArrowDown") next = items[(index + 1) % items.length];
    else if (event.key === "ArrowUp") next = items[(index - 1 + items.length) % items.length];
    else if (event.key === "Home") next = items[0];
    else if (event.key === "End") next = items.at(-1);
    else if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      dismiss();
      return;
    } else return;
    event.preventDefault();
    next?.focus();
  };

  const withIcons = request.items.some((item) => isAction(item) && (item.icon || item.media));
  return createPortal(
    <div
      className="menu"
      role="menu"
      aria-label={request.label}
      ref={menuRef}
      style={position}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      {request.items.map((item, index) =>
        isAction(item) ? (
          <button
            key={item.id ?? item.label}
            className={cx("menu-item", item.tone === "danger" && "is-danger")}
            type="button"
            {...(item.checked === undefined
              ? { role: "menuitem" }
              : { role: "menuitemcheckbox", "aria-checked": item.checked })}
            tabIndex={-1}
            aria-disabled={item.disabled || undefined}
            title={item.title}
            onClick={() => {
              if (item.disabled) return;
              dismiss();
              item.run();
            }}
          >
            {withIcons ? (
              <span className="menu-item-icon" aria-hidden="true">
                {item.media ?? (item.icon ? <Icon name={item.icon} size={13} /> : null)}
              </span>
            ) : null}
            <span className="menu-item-label">{item.label}</span>
            {item.shortcut ? <span className="menu-shortcut">{shortcutText(item.shortcut)}</span> : null}
            {item.checked ? <Icon className="menu-item-check" name="check" size={13} /> : null}
          </button>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: separators have no identity of their own.
          <hr key={`separator-${index}`} className="menu-separator" />
        ),
      )}
    </div>,
    document.body,
  );
}

type AnchoredMenuButtonProps = {
  /** The button's accessible name, and the menu's. */
  label: string;
  icon: IconName;
  items: readonly MenuEntry[];
  tooltip?: string | undefined;
  /** Shown as key caps in the tooltip. */
  shortcut?: string | undefined;
  size?: "xs" | "sm" | "md";
  iconSize?: number | undefined;
  disabled?: boolean | undefined;
  /** Which edge of the button the menu lines up with. */
  align?: "start" | "end" | undefined;
  className?: string | undefined;
  ref?: Ref<HTMLButtonElement>;
};

type PopupMenuButtonProps = {
  /** The button's accessible name and tooltip, and the menu's label. */
  label: string;
  items: () => MenuItem[];
  icon?: IconName;
  size?: "xs" | "sm" | "md";
  variant?: ButtonVariant;
  className?: string | undefined;
  /** Tooltip text when it should be shorter than the accessible name. */
  tooltip?: string | undefined;
  /** Text shown next to the icon; without it the button is icon-only. */
  children?: ReactNode;
  disabled?: boolean | undefined;
};

/**
 * An icon button that opens a short menu. An array of items keeps the phone menu (checks, above the button).
 * A function is read when the menu opens and shows the shared popup used by Changes and Files.
 */
export function MenuButton(props: AnchoredMenuButtonProps | PopupMenuButtonProps) {
  if (typeof props.items === "function") return <PopupMenuButton {...props} items={props.items} />;
  const { items, icon = "more", ...rest } = props;
  return <AnchoredMenuButton {...rest} items={items} icon={icon} />;
}

/** A button that opens a menu below it, right-aligned; the items are read when it opens. */
function PopupMenuButton({
  label,
  items,
  icon = "more",
  size = "sm",
  variant = "ghost",
  className,
  tooltip,
  children,
  disabled,
}: PopupMenuButtonProps) {
  const [request, setRequest] = useState<MenuRequest>();
  const close = () => setRequest(undefined);
  return (
    <>
      <button
        type="button"
        className={cx("btn", `btn-${variant}`, !children && "btn-icon", size !== "md" && `btn-${size}`, className)}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={!!request}
        data-tooltip={request ? undefined : (tooltip ?? label)}
        disabled={disabled}
        onClick={(event) => {
          if (request) {
            close();
            return;
          }
          const anchor = event.currentTarget;
          const rect = anchor.getBoundingClientRect();
          setRequest({ x: rect.right, y: rect.bottom + GAP, align: "end", anchor, label, items: items() });
        }}
      >
        <Icon name={icon} size={size === "xs" ? 12 : size === "sm" ? 13 : 14} />
        {children}
      </button>
      {request ? <Menu request={request} onClose={close} /> : null}
    </>
  );
}

/**
 * An icon button that opens a short menu of actions. The menu opens above the button when it fits and lines up
 * with its right edge. Arrow keys, Home, and End move between items; Escape, Tab, or a click elsewhere closes it
 * and gives focus back to the button. Focus returns to the button before an item runs, so an item can move it on.
 */
function AnchoredMenuButton({
  label,
  icon,
  items,
  tooltip,
  shortcut,
  size = "sm",
  iconSize,
  disabled = false,
  align = "end",
  className,
  ref,
}: AnchoredMenuButtonProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const placement = useAnchoredPlacement(open, triggerRef, menuRef, {
    prefer: "above",
    align,
    gap: ANCHORED_GAP,
    edge: EDGE,
  });
  const menuId = useId();
  const focusLastRef = useRef(false);

  const setTrigger = (node: HTMLButtonElement | null) => {
    triggerRef.current = node;
    if (typeof ref === "function") ref(node);
    else if (ref) ref.current = node;
  };

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };

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
        className={cx("btn btn-ghost btn-icon", size !== "md" && `btn-${size}`, className)}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        data-tooltip={open ? undefined : (tooltip ?? label)}
        data-shortcut={shortcut ? shortcutText(shortcut) : undefined}
        aria-keyshortcuts={shortcut ? ariaShortcut(shortcut) : undefined}
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
              data-align={align}
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
                      {...(entry.checked === undefined
                        ? { role: "menuitem" }
                        : { role: "menuitemcheckbox", "aria-checked": entry.checked })}
                      tabIndex={-1}
                      className={cx("menu-item", entry.detail && "has-detail")}
                      aria-disabled={entry.disabled || undefined}
                      title={entry.title}
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
                      {entry.detail ? (
                        <span className="menu-item-text">
                          <span className="menu-item-label">{entry.label}</span>
                          <span className="menu-item-detail">{entry.detail}</span>
                        </span>
                      ) : (
                        <span className="menu-item-label">{entry.label}</span>
                      )}
                      {entry.checked ? <Icon className="menu-item-check" name="check" size={14} /> : null}
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
  return [
    ...(menu?.querySelectorAll<HTMLElement>(
      ':is([role="menuitem"], [role="menuitemcheckbox"]):not([aria-disabled="true"])',
    ) ?? []),
  ];
}
