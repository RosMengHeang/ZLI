import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon.js";

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
    <div className="tool-pane-header">
      <div className="tool-pane-title">
        <Icon name={icon} size={15} />
        <h2>{title}</h2>
        {detail ? (
          <span className="tool-pane-detail" title={detail}>
            {detail}
          </span>
        ) : null}
      </div>
      {children ? <div className="tool-pane-actions">{children}</div> : null}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  detail,
  children,
  className,
}: {
  icon: IconName;
  title: string;
  detail?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`empty-pane${className ? ` ${className}` : ""}`}>
      <span className="empty-icon">
        <Icon name={icon} size={20} />
      </span>
      <p className="empty-title">{title}</p>
      {detail ? <p className="empty-detail">{detail}</p> : null}
      {children}
    </div>
  );
}
