import { Icon } from "../ui/Icon.js";

type HelpDialogProps = {
  version?: string | undefined;
  onSupportBundle(): void;
  onImportLegacy(): void;
  onClose(): void;
};

const shortcuts: [string, string][] = [
  ["Command palette", "Ctrl K"],
  ["Send message", "Enter"],
  ["New line in message", "Shift Enter"],
  ["Close dialog", "Esc"],
];

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
            <h2>Help and diagnostics</h2>
            <p className="dialog-subtitle">
              Agents, terminals, and browser tabs run in a local runtime. Each worktree keeps its own sessions.
            </p>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close">
            <Icon name="x" size={15} />
          </button>
        </div>
        <div className="help-body">
          <dl className="help-shortcuts">
            {shortcuts.map(([label, keys]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>
                  {keys.split(" ").map((key) => (
                    <kbd key={key}>{key}</kbd>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
          <div className="help-actions">
            <button className="menu-item" type="button" onClick={onSupportBundle}>
              <Icon name="download" size={15} />
              <span>
                Export redacted support bundle
                <small>Logs and state with secrets removed</small>
              </span>
            </button>
            <button className="menu-item" type="button" onClick={onImportLegacy}>
              <Icon name="upload" size={15} />
              <span>
                Import legacy snapshot
                <small>Bring projects over from the previous ZLI app</small>
              </span>
            </button>
          </div>
          <span className="help-version">ZLI {version ?? "development"}</span>
        </div>
      </section>
    </div>
  );
}
