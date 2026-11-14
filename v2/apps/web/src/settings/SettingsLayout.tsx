import { type ReactNode, useId } from "react";

/*
 * The one set of building blocks every Settings page is made of:
 *   SettingsPageHeader  the page title and one line on what the page is for
 *   SettingsGroup       a titled group; its rows sit on one quiet bordered surface
 *   SettingsRow         one setting: name and description on the left, the control on the right
 * Lists of things (servers, accounts, devices, projects) go in a bare group, whose list gets the same surface.
 */

/** The title at the top of a Settings page, with an optional line under it. */
export function SettingsPageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="settings-page-header">
      <h3 className="settings-page-title">{title}</h3>
      {children ? <p className="settings-page-note">{children}</p> : null}
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
export function SettingsRow({
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

/**
 * A titled group on a Settings page. Its children are rows on one bordered surface, unless `bare` is set: then
 * they are placed as given, for a list that brings its own rows (and gets the same surface from its class).
 * `tone="danger"` marks the group that holds actions which remove things; it goes last on the page.
 */
export function SettingsGroup({
  title,
  description,
  actions,
  tone,
  bare = false,
  label,
  className,
  children,
}: {
  title?: ReactNode;
  description?: ReactNode;
  /** Controls for the whole group, shown at the right of its title. */
  actions?: ReactNode;
  tone?: "danger" | undefined;
  bare?: boolean;
  /** The accessible name, when it should say more than the visible title (or there is none). */
  label?: string | undefined;
  className?: string | undefined;
  children: ReactNode;
}) {
  const id = useId();
  const classes = ["settings-group", tone ? `is-${tone}` : "", className ?? ""].filter(Boolean).join(" ");
  const hasHead = title !== undefined || actions !== undefined;
  return (
    <section
      className={classes}
      aria-labelledby={label === undefined && title !== undefined ? id : undefined}
      aria-label={label}
    >
      {hasHead ? (
        <div className="settings-group-head">
          {title !== undefined ? (
            <h4 id={id} className="settings-group-title">
              {title}
            </h4>
          ) : (
            <span className="settings-group-title" />
          )}
          {actions ? <div className="settings-group-actions">{actions}</div> : null}
        </div>
      ) : null}
      {description ? <p className="settings-group-note">{description}</p> : null}
      {bare ? <div className="settings-group-body">{children}</div> : <div className="setting-list">{children}</div>}
    </section>
  );
}
