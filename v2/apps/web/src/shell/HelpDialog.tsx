import { Button } from "../ui/Button.js";
import { Dialog } from "../ui/Dialog.js";
import { Icon, type IconName } from "../ui/Icon.js";
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
      title="Help"
      subtitle="Keyboard shortcuts and support tools. You can change shortcuts in Settings."
      size="lg"
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
        <section className="help-section" aria-label="Support">
          <h3 className="help-section-title">Support</h3>
          <div className="help-actions">
            <HelpAction
              icon="download"
              title="Export support bundle"
              detail="Logs and app state with secrets removed. Attach it to a bug report."
              onClick={onSupportBundle}
            />
            <HelpAction
              icon="upload"
              title="Import legacy snapshot"
              detail="Move projects over from the previous ZLI app."
              onClick={onImportLegacy}
            />
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
        <span className="dialog-footer-note help-footer-note">
          Runs locally. Each worktree keeps its own agents and terminals.
        </span>
      </div>
    </Dialog>
  );
}

function HelpAction({
  icon,
  title,
  detail,
  onClick,
}: {
  icon: IconName;
  title: string;
  detail: string;
  onClick(): void;
}) {
  return (
    <button className="help-action" type="button" onClick={onClick}>
      <span className="help-action-icon" aria-hidden="true">
        <Icon name={icon} size={15} />
      </span>
      <span className="help-action-text">
        <span className="help-action-title">{title}</span>
        <span className="help-action-detail">{detail}</span>
      </span>
    </button>
  );
}
