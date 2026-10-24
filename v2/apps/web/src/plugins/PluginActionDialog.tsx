import type { PluginAction, PluginOrigin } from "@zli-v2/contracts";
import { useRef, useState } from "react";

import { Button } from "../ui/Button.js";
import { Dialog } from "../ui/Dialog.js";
import { OriginBadge } from "./OriginBadge.js";
import "./plugins.css";

/** Asks before a plugin action runs a command for the first time. */
export function PluginActionDialog({
  action,
  pluginName,
  origin,
  canRemember,
  onRun,
  onCancel,
}: {
  action: PluginAction;
  pluginName: string;
  origin: PluginOrigin;
  /** False when this window cannot keep approvals, so the checkbox is left out. */
  canRemember: boolean;
  onRun(remember: boolean): void;
  onCancel(): void;
}) {
  const [remember, setRemember] = useState(true);
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      label="Run plugin action"
      size="sm"
      title={`Run ${action.name} from ${pluginName}?`}
      subtitle="It runs in a terminal in the current worktree, with your permissions."
      scrimLabel="Cancel"
      showClose={false}
      initialFocusRef={cancelRef}
      onClose={onCancel}
    >
      <div className="dialog-body plugin-action-confirm">
        <div className="plugin-action-source">
          <span>{pluginName}</span>
          <OriginBadge origin={origin} />
        </div>
        <pre className="plugin-action-command">
          <code>{action.command}</code>
        </pre>
        {canRemember ? (
          <label className="check-field plugin-remember">
            <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
            <span className="choice-copy">
              <span className="choice-title">Don't ask again for this command</span>
              <span className="choice-detail">ZLI asks again if the plugin changes it.</span>
            </span>
          </label>
        ) : null}
      </div>
      <div className="dialog-footer">
        <Button ref={cancelRef} onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => onRun(canRemember && remember)}>
          Run
        </Button>
      </div>
    </Dialog>
  );
}
