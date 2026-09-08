import type { ReactNode } from "react";
import { canDismissDialog } from "../lib/dialogBehavior";
import { IconClose } from "./AppIcons";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

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

export function Modal({
  title,
  open,
  onClose,
  children,
  width = 420,
  danger,
  busy = false,
  description,
  dismissible = true,
}: ModalProps) {
  const blocked = !canDismissDialog({ dismissible, busy });

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen && !blocked) onClose(); }}>
      <DialogContent
        showCloseButton={false}
        className="max-h-[80vh] gap-0 overflow-y-auto border-line bg-panel p-0 text-paper shadow-xl"
        style={{ width, maxWidth: "calc(100vw - 32px)" }}
        onEscapeKeyDown={(event) => { if (blocked) event.preventDefault(); }}
        onPointerDownOutside={(event) => { if (blocked) event.preventDefault(); }}
      >
        <DialogHeader className={`flex-row items-center justify-between gap-3 border-b border-line px-4 py-3 text-left ${danger ? "text-danger" : ""}`}>
          <div className="min-w-0">
            <DialogTitle className="truncate text-[13px] font-semibold tracking-tight">{title}</DialogTitle>
            {description ? <DialogDescription className="mt-1 text-[12px] leading-5 text-mute">{description}</DialogDescription> : null}
          </div>
          <Button type="button" variant="ghost" size="icon-sm" disabled={blocked} onClick={onClose} aria-label="Close" title="Close dialog">
            <IconClose />
          </Button>
        </DialogHeader>
        <div className="p-4">{children}</div>
      </DialogContent>
    </Dialog>
  );
}
