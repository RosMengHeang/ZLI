import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { shortcutText } from "../ui/shortcuts.js";

export type ContextMenuItem = {
  label: string;
  shortcut?: string | undefined;
  disabled?: boolean | undefined;
  /** Why the item is disabled, or what it does. */
  title?: string | undefined;
  run(): void;
};
export type ContextMenuRequest = { x: number; y: number; label: string; items: ContextMenuItem[] };

const EDGE = 4;

/** A right-click menu. Arrow keys move between items; Escape, a click elsewhere, or scrolling closes it. */
export function FilesContextMenu({ request, onClose }: { request: ContextMenuRequest; onClose(): void }) {
  const menuRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const [position, setPosition] = useState({ left: request.x, top: request.y });

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    setPosition({
      left: Math.max(EDGE, Math.min(request.x, window.innerWidth - rect.width - EDGE)),
      top: Math.max(EDGE, Math.min(request.y, window.innerHeight - rect.height - EDGE)),
    });
    menu.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus();
  }, [request]);

  useEffect(() => {
    const close = (event: Event) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
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
  }, [onClose]);

  const dismiss = () => {
    onClose();
    returnFocus.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [
      ...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? []),
    ];
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

  return createPortal(
    <div
      className="files-menu"
      role="menu"
      aria-label={request.label}
      ref={menuRef}
      style={position}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      {request.items.map((item) => (
        <button
          key={item.label}
          className="files-menu-item"
          type="button"
          role="menuitem"
          tabIndex={-1}
          aria-disabled={item.disabled || undefined}
          title={item.title}
          onClick={() => {
            if (item.disabled) return;
            dismiss();
            item.run();
          }}
        >
          <span>{item.label}</span>
          {item.shortcut ? <span className="files-menu-shortcut">{shortcutText(item.shortcut)}</span> : null}
        </button>
      ))}
    </div>,
    document.body,
  );
}
