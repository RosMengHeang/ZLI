import type { ReactNode } from "react";

export type BadgeTone = "neutral" | "info" | "warning" | "danger" | "success" | "quiet";

/** A short status label. Only for real state, never for decoration. */
export function Badge({
  tone = "neutral",
  dot = false,
  spinner = false,
  className,
  title,
  children,
}: {
  tone?: BadgeTone;
  dot?: boolean;
  spinner?: boolean;
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <span className={`badge badge-${tone}${className ? ` ${className}` : ""}`} title={title}>
      {spinner ? (
        <span className="spinner" aria-hidden="true" />
      ) : dot ? (
        <span className="dot" aria-hidden="true" />
      ) : null}
      <span className="badge-label">{children}</span>
    </span>
  );
}
