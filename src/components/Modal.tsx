import { useEffect, useRef, useId, type ReactNode } from "react";
import { canDismissDialog } from "../lib/dialogBehavior";
import { IconClose } from "./AppIcons";

interface ModalProps {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  danger?: boolean;
  busy?: boolean;
  description?: string;
  dismissible?: boolean;
}

function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => !el.hasAttribute("disabled") && el.tabIndex !== -1);
}

export function Modal({ title, open, onClose, children, width = 420, danger, busy = false, description, dismissible = true }: ModalProps) {
  const titleId = useId();
  const descriptionId = useId();
  const blocked = !canDismissDialog({ dismissible, busy });
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const busyRef = useRef(blocked);
  useEffect(() => { busyRef.current = blocked; }, [blocked]);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = dialogRef.current;
    const frame = requestAnimationFrame(() => {
      const preferred = root?.querySelector<HTMLElement>(
        "input:not([type=hidden]):not([disabled]), textarea:not([disabled]), select:not([disabled])",
      );
      const items = root ? focusableIn(root) : [];
      (preferred ?? items[0] ?? root)?.focus();
    });

    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!busyRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !root) return;
      const items = focusableIn(root);
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKey, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKey, true);
      previous?.focus();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 pt-[12vh]"
      onClick={() => { if (!busyRef.current) onCloseRef.current(); }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className="surface-dialog outline-none"
        style={{ width, maxWidth: "calc(100vw - 32px)", maxHeight: "80vh", overflowY: "auto" }}
        onClick={(event) => event.stopPropagation()}
      >
        <div
          className={`flex h-10 items-center justify-between border-b border-line px-3 ${
            danger ? "bg-chrome text-danger" : "bg-chrome"
          }`}
        >
          <h2 id={titleId} className="text-[13px] font-semibold tracking-tight">
            {title}
          </h2>
          <button type="button" className="btn btn-icon" disabled={blocked} onClick={() => onCloseRef.current()} aria-label="Close" title="Close dialog">
            <IconClose />
          </button>
        </div>
        <div className="p-4">{description ? <p id={descriptionId} className="mb-4 text-[12px] leading-5 text-mute">{description}</p> : null}{children}</div>
      </div>
    </div>
  );
}
