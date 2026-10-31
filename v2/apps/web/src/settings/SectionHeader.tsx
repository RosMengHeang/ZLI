import { type ReactNode, useId } from "react";

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

/** A titled block of setting rows, the way IDE settings pages split one page into groups. */
export function SettingGroup({
  title,
  description,
  actions,
  className,
  children,
}: {
  title: string;
  description?: ReactNode;
  /** Controls for the whole group, shown at the right of its title. */
  actions?: ReactNode;
  className?: string | undefined;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className={`settings-group${className ? ` ${className}` : ""}`} aria-labelledby={id}>
      <div className="settings-group-head">
        <h4 id={id} className="settings-group-title">
          {title}
        </h4>
        {actions ? <div className="settings-group-actions">{actions}</div> : null}
      </div>
      {description ? <p className="settings-group-note">{description}</p> : null}
      <div className="setting-list">{children}</div>
    </section>
  );
}
