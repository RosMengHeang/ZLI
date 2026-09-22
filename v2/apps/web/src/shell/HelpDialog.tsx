type HelpDialogProps = {
  version?: string | undefined;
  onSupportBundle(): void;
  onImportLegacy(): void;
  onClose(): void;
};

export function HelpDialog({ version, onSupportBundle, onImportLegacy, onClose }: HelpDialogProps) {
  return (
    <div className="palette-backdrop">
      <button className="dialog-scrim" type="button" aria-label="Close help dialog" onClick={onClose} />
      <section
        className="worktree-dialog help-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Help and diagnostics"
      >
        <div className="dialog-header">
          <div>
            <span className="eyebrow">ZLI V2</span>
            <h2>Help and diagnostics</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="help-body">
          <p>
            ZLI keeps the desktop shell, local runtime, terminals, browser tabs, and agent sessions behind a durable RPC
            boundary.
          </p>
          <div className="help-actions">
            <button className="secondary-button" type="button" onClick={onSupportBundle}>
              Export redacted support bundle
            </button>
            <button className="secondary-button" type="button" onClick={onImportLegacy}>
              Import legacy snapshot
            </button>
          </div>
          <span className="help-version">Version {version ?? "development"}</span>
        </div>
      </section>
    </div>
  );
}
