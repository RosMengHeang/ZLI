import type { ReactNode } from "react";

export function SectionHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="settings-section-header">
      <h3 className="settings-section-title">{title}</h3>
      {children ? <p className="settings-section-note">{children}</p> : null}
    </header>
  );
}

/** A word in running copy that jumps elsewhere in Settings, or plain text when there is nowhere to go. */
export function TextLink({ onClick, children }: { onClick?: (() => void) | undefined; children: ReactNode }) {
  if (!onClick) return <>{children}</>;
  return (
    <button type="button" className="connector-link text-link" onClick={onClick}>
      {children}
    </button>
  );
}

/** One setting: its name and what it does on the left, the control on the right. */
export function SettingRow({
  label,
  description,
  descriptionTone,
  htmlFor,
  children,
}: {
  label: string;
  description?: ReactNode;
  descriptionTone?: "warning" | undefined;
  htmlFor?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="setting-row">
      <div className="setting-copy">
        {htmlFor ? (
          <label className="setting-label" htmlFor={htmlFor}>
            {label}
          </label>
        ) : (
          <span className="setting-label">{label}</span>
        )}
        {description ? (
          <p className={`setting-description${descriptionTone ? ` is-${descriptionTone}` : ""}`}>{description}</p>
        ) : null}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}
