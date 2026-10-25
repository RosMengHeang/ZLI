import { type KeyboardEvent, type ReactNode, useRef } from "react";

import { Button } from "../ui/Button.js";
import { Dialog } from "../ui/Dialog.js";

/** Asks before a Git change that cannot be taken back, such as discarding edits or dropping a stash. */
export function ConfirmDialog({
  label,
  title,
  detail,
  confirmLabel,
  busy = false,
  onConfirm,
  onCancel,
}: {
  label: string;
  title: string;
  detail: ReactNode;
  confirmLabel: string;
  busy?: boolean;
  onConfirm(): void;
  onCancel(): void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const closeOnEscape = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && !busy) onCancel();
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape from anywhere inside the dialog closes it.
    <div onKeyDown={closeOnEscape}>
      <Dialog
        label={label}
        size="sm"
        title={title}
        subtitle={detail}
        scrimLabel="Cancel"
        showClose={false}
        initialFocusRef={cancelRef}
        onClose={() => {
          if (!busy) onCancel();
        }}
      >
        <div className="dialog-footer">
          <Button ref={cancelRef} disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="danger" loading={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
