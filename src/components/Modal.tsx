import type { ReactNode } from "react";

interface ModalProps {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  danger?: boolean;
}

export function Modal({ title, open, onClose, children, width = 420, danger }: ModalProps) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[12vh]"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        className="border border-[#3e3e42] bg-[#252526] shadow-xl"
        style={{ width }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div
          className={`flex h-8 items-center justify-between border-b border-[#3e3e42] px-3 ${
            danger ? "bg-[#5a1d1d]" : "bg-[#2d2d2d]"
          }`}
        >
          <h2 id="modal-title" className="text-[12px] font-semibold tracking-tight">
            {title}
          </h2>
          <button
            type="button"
            className="px-1 text-[#8b8b8b] hover:text-white"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="p-3">{children}</div>
      </div>
    </div>
  );
}
