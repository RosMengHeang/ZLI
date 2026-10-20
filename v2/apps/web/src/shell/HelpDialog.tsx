import { Dialog } from "../ui/Dialog.js";
import { Icon } from "../ui/Icon.js";
import { Kbd } from "../ui/Kbd.js";

type HelpDialogProps = {
  version?: string | undefined;
  onSupportBundle(): void;
  onImportLegacy(): void;
  onClose(): void;
};

const shortcutGroups: { title: string; items: [string, string][] }[] = [
  {
    title: "Workspace",
    items: [
      ["Command palette", "Mod+K"],
      ["New agent", "Mod+N"],
      ["Go to file", "Mod+P"],
      ["Search in files", "Mod+Shift+F"],
      ["Show or hide the sidebar", "Mod+B"],
      ["Show or hide the terminal", "Mod+J"],
    ],
  },
  {
    title: "Messages and dialogs",
    items: [
      ["Send message", "Enter"],
      ["New line in a message", "Shift+Enter"],
      ["Close a dialog or panel", "Esc"],
    ],
  },
];

export function HelpDialog({ version, onSupportBundle, onImportLegacy, onClose }: HelpDialogProps) {
  return (
    <Dialog
      label="Help and diagnostics"
      title="Help and diagnostics"
      subtitle="Agents, terminals, and browser tabs run in a local runtime. Each worktree keeps its own sessions."
      className="help-dialog"
      scrimLabel="Close help dialog"
      onClose={onClose}
    >
      <div className="dialog-body help-body">
        {shortcutGroups.map((group) => (
          <section className="help-section" key={group.title} aria-label={group.title}>
            <h3 className="help-section-title">{group.title}</h3>
            <dl className="help-shortcuts">
              {group.items.map(([label, shortcut]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>
                    <Kbd shortcut={shortcut} />
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
        <section className="help-section" aria-label="Diagnostics">
          <h3 className="help-section-title">Diagnostics</h3>
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
        </section>
      </div>
      <div className="dialog-footer">
        <span className="dialog-footer-note help-version">ZLI {version ?? "development"}</span>
      </div>
    </Dialog>
  );
}
