import { type KeyboardEvent, useState } from "react";

import { Button } from "../ui/Button.js";
import { Dialog } from "../ui/Dialog.js";

/** Asks which branch this worktree's branch should be merged into on this computer. */
export function MergeBranchDialog({
  branch,
  target,
  onMerge,
  onClose,
}: {
  branch: string;
  target: string;
  onMerge(target: string): Promise<void>;
  onClose(): void;
}) {
  const [picked, setPicked] = useState(target);
  const [running, setRunning] = useState(false);
  const closeOnEscape = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && !running) onClose();
  };
  const merge = async () => {
    setRunning(true);
    try {
      await onMerge(picked.trim());
    } finally {
      setRunning(false);
    }
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape from anywhere inside the dialog closes it.
    <div onKeyDown={closeOnEscape}>
      <Dialog
        label="Merge into another branch"
        className="pr-dialog"
        size="sm"
        title="Merge into another branch"
        subtitle={
          <>
            Merges <span className="is-mono">{branch}</span> on this computer. Conflicts stop the merge.
          </>
        }
        onClose={() => {
          if (!running) onClose();
        }}
      >
        <div className="dialog-body">
          <label className="field">
            <span className="field-label">Merge into</span>
            <input
              className="input is-mono"
              aria-label="Merge target"
              value={picked}
              spellCheck={false}
              onChange={(event) => setPicked(event.target.value)}
            />
          </label>
        </div>
        <div className="dialog-footer">
          <Button variant="ghost" disabled={running} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon="merge"
            loading={running}
            disabled={!picked.trim()}
            onClick={() => void merge()}
          >
            Merge
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
