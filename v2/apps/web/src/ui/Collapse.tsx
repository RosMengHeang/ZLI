import { type ReactNode, useEffect, useState } from "react";

const CLOSE_MS = 200;

function reducedMotion(): boolean {
  return typeof window.matchMedia !== "function" || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Content that grows open and shrinks closed instead of appearing at full height. It mounts when it
 * opens and unmounts once the closing transition is over, so closed content costs nothing.
 */
export function Collapse({ open, className, children }: { open: boolean; className?: string; children: ReactNode }) {
  const [mounted, setMounted] = useState(open);

  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    if (reducedMotion()) {
      setMounted(false);
      return;
    }
    // A timer instead of transitionend: the event never fires when the transition is cut short.
    const timer = setTimeout(() => setMounted(false), CLOSE_MS);
    return () => clearTimeout(timer);
  }, [open]);

  if (!mounted && !open) return null;
  return (
    <div className={`collapse${className ? ` ${className}` : ""}`} data-open={open}>
      <div className="collapse-inner">{children}</div>
    </div>
  );
}
