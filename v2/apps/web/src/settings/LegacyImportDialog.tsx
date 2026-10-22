import type { RuntimeProjection } from "@zli-v2/contracts";
import { useEffect, useState } from "react";

import { Button } from "../ui/Button.js";
import { Dialog } from "../ui/Dialog.js";
import { Icon } from "../ui/Icon.js";
import { LoadingState } from "../ui/Pane.js";

type LegacyImportDialogProps = {
  projection: RuntimeProjection;
  batchId: string;
  onImport(selectedRecordIds: string[]): void;
  onRollback(): void;
  onClose(): void;
};

export function LegacyImportDialog({ projection, batchId, onImport, onRollback, onClose }: LegacyImportDialogProps) {
  const state = projection.legacyImport;
  const preview = state?.batchId === batchId ? state.preview : undefined;
  const [selected, setSelected] = useState<string[]>([]);
  const defaultSelectionKey = JSON.stringify(
    preview
      ? [
          ...preview.projects.filter((item) => item.state === "ready").map((item) => item.recordId),
          ...preview.worktrees.filter((item) => item.state === "ready").map((item) => item.recordId),
        ]
      : [],
  );

  useEffect(() => {
    setSelected(JSON.parse(defaultSelectionKey) as string[]);
  }, [defaultSelectionKey]);

  const toggle = (recordId: string) => {
    setSelected((current) =>
      current.includes(recordId) ? current.filter((id) => id !== recordId) : [...current, recordId],
    );
  };

  return (
    <Dialog
      label="Import legacy workspace"
      size="lg"
      title="Import legacy workspace"
      subtitle="Review what will be imported. The legacy data is never changed."
      className="legacy-import-dialog"
      scrimLabel="Close import dialog"
      onClose={onClose}
    >
      {!preview && state?.status === "scanning" && (
        <div className="dialog-body">
          <LoadingState label="Reading the snapshot without changing legacy data" />
        </div>
      )}
      {!preview && state?.status === "failed" && (
        <div className="dialog-body">
          <p className="inline-error" role="alert">
            <Icon name="alert" size={13} />
            {state.error}
          </p>
        </div>
      )}
      {preview && (
        <>
          <div className="dialog-body legacy-import-body">
            <p className="import-summary">
              {preview.projects.length} projects · {preview.worktrees.length} worktrees · {preview.sessions.length}{" "}
              sessions
            </p>
            <div className="import-records">
              {preview.projects.map((project) => (
                <label className="import-record" key={project.recordId}>
                  <input
                    type="checkbox"
                    checked={selected.includes(project.recordId)}
                    disabled={project.state !== "ready"}
                    onChange={() => toggle(project.recordId)}
                  />
                  <span>
                    <strong>{project.name}</strong>
                    <small>
                      {project.path} · {project.state}
                    </small>
                  </span>
                </label>
              ))}
              {preview.worktrees.map((worktree) => (
                <label className="import-record import-child" key={worktree.recordId}>
                  <input
                    type="checkbox"
                    checked={selected.includes(worktree.recordId)}
                    disabled={worktree.state !== "ready"}
                    onChange={() => toggle(worktree.recordId)}
                  />
                  <span>
                    <strong>{worktree.branch}</strong>
                    <small>
                      {worktree.path} · {worktree.state}
                    </small>
                  </span>
                </label>
              ))}
            </div>
            {preview.conflicts.length > 0 && (
              <p className="field-hint is-warning">
                {preview.conflicts.length} conflict(s) require review and will not be imported.
              </p>
            )}
            {preview.sessions.some((session) => session.resume !== "exact") && (
              <p className="field-hint is-warning">
                Some provider sessions cannot be resumed exactly; they remain listed for reference.
              </p>
            )}
          </div>
          <div className="dialog-footer">
            <Button onClick={onClose}>Cancel</Button>
            {state?.status === "imported" && <Button onClick={onRollback}>Rollback this batch</Button>}
            <Button
              variant="primary"
              disabled={selected.length === 0}
              loading={state?.status === "importing"}
              onClick={() => onImport(selected)}
            >
              {state?.status === "importing" ? "Importing" : "Import selected"}
            </Button>
          </div>
        </>
      )}
    </Dialog>
  );
}
