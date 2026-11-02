import { type KeyboardEvent, type ReactNode, type RefObject, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { IconButton } from "./Button.js";

const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * A modal dialog. Escape is handled by the shell, which closes every overlay at once; the dialog
 * keeps Tab inside itself and gives focus back to where it was when it closes. A stacked dialog opens
 * from inside another dialog or a panel the shell does not track, so it closes itself on Escape.
 */
export function Dialog({
  label,
  title,
  subtitle,
  size = "md",
  className,
  scrimLabel,
  showClose = true,
  initialFocusRef,
  stacked = false,
  onClose,
  children,
}: {
  label: string;
  title?: ReactNode;
  subtitle?: ReactNode;
  size?: "sm" | "md" | "lg";
  className?: string;
  /** Accessible name of the click-outside area. */
  scrimLabel?: string;
  showClose?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
  /**
   * Renders over everything, closes on Escape without closing what it opened from, and keeps Tab from
   * reaching the dialog under it.
   */
  stacked?: boolean;
  onClose(): void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const target = initialFocusRef?.current ?? ref.current?.querySelector<HTMLElement>(FOCUSABLE) ?? undefined;
    if (target && !ref.current?.contains(document.activeElement)) target.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, [initialFocusRef]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (stacked && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !ref.current) return;
    if (stacked) event.stopPropagation();
    const focusable = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (element) => element.offsetParent !== null || element === document.activeElement,
    );
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const dialog = (
    <div className="dialog-backdrop">
      <button
        className="dialog-scrim"
        type="button"
        tabIndex={-1}
        aria-label={scrimLabel ?? `Close ${label.toLowerCase()}`}
        onClick={onClose}
      />
      <section
        ref={ref}
        className={`dialog${size === "md" ? "" : ` dialog-${size}`}${className ? ` ${className}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onKeyDown={onKeyDown}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {title ? (
          <header className="dialog-header">
            <div>
              <h2 className="dialog-title">{title}</h2>
              {subtitle ? <p className="dialog-subtitle">{subtitle}</p> : null}
            </div>
            {showClose ? <IconButton label="Close" icon="x" size="sm" onClick={onClose} /> : null}
          </header>
        ) : null}
        {children}
      </section>
    </div>
  );
  return stacked ? createPortal(dialog, document.body) : dialog;
}
