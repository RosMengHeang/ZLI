import { Button } from "../ui/Button.js";
import { Dialog } from "../ui/Dialog.js";
import { Icon } from "../ui/Icon.js";
import { Kbd } from "../ui/Kbd.js";
import { shortcutActions, useShortcuts } from "./keybindings.js";

type HelpDialogProps = {
  version?: string | undefined;
  onSupportBundle(): void;
  onImportLegacy(): void;
  /** Opens Settings at Updates; the button is hidden without it. */
  onOpenUpdates?: (() => void) | undefined;
  onClose(): void;
};

const fixedGroups: { title: string; items: [string, string][] }[] = [
  {
    title: "Messages and dialogs",
    items: [
      ["Send message", "Enter"],
      ["New line in a message", "Shift+Enter"],
      ["Close a dialog or panel", "Esc"],
    ],
  },
];

export function HelpDialog({ version, onSupportBundle, onImportLegacy, onOpenUpdates, onClose }: HelpDialogProps) {
  const shortcuts = useShortcuts();
  const shortcutGroups = [
    {
      title: "Workspace",
      items: shortcutActions.map((action): [string, string] => [action.label, shortcuts[action.id]]),
    },
    ...fixedGroups,
  ];
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
        {onOpenUpdates ? (
          <Button size="sm" variant="ghost" icon="reload" onClick={onOpenUpdates}>
            Check for updates
          </Button>
        ) : null}
      </div>
    </Dialog>
  );
}
