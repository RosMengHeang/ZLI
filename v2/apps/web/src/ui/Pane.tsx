import type { ReactNode } from "react";

import { Icon, type IconName } from "./Icon.js";
import { Kbd } from "./Kbd.js";

/** The header row every utility pane starts with: icon, title, context, then actions. */
export function PaneHeader({
  icon,
  title,
  detail,
  children,
}: {
  icon: IconName;
  title: string;
  detail?: string | undefined;
  children?: ReactNode;
}) {
  return (
    <div className="pane-header">
      <div className="pane-title">
        <Icon name={icon} size={14} />
        <h2 title={title}>{title}</h2>
        {detail ? (
          <span className="pane-detail" title={detail}>
            {detail}
          </span>
        ) : null}
      </div>
      {children ? <div className="pane-actions">{children}</div> : null}
    </div>
  );
}

/** Explains why a view is empty and offers the action that fills it. */
export function EmptyState({
  icon,
  title,
  detail,
  hint,
  tone,
  size,
  children,
  className,
}: {
  icon: IconName;
  title: string;
  detail?: ReactNode;
  /** A keyboard shortcut that does the same as the main action, for example "Mod+N". */
  hint?: { label: string; shortcut: string } | undefined;
  tone?: "danger";
  size?: "large";
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`empty-state${size === "large" ? " is-large" : ""}${className ? ` ${className}` : ""}`}>
      <span className={`empty-state-icon${tone === "danger" ? " is-danger" : ""}`}>
        <Icon name={icon} size={18} />
      </span>
      <p className="empty-state-title">{title}</p>
      {detail ? <p className="empty-state-detail">{detail}</p> : null}
      {children ? <div className="empty-state-actions">{children}</div> : null}
      {hint ? (
        <p className="empty-state-hint">
          {hint.label} <Kbd shortcut={hint.shortcut} />
        </p>
      ) : null}
    </div>
  );
}

/** A view that is waiting for data. The label says what is loading. */
export function LoadingState({ label, className }: { label: string; className?: string }) {
  return (
    <div className={`empty-state is-loading${className ? ` ${className}` : ""}`} role="status">
      <p className="loading-line">
        <span className="spinner" aria-hidden="true" />
        {label}
      </p>
    </div>
  );
}
