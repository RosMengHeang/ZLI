import { useEffect, useState } from "react";

import type { RuntimeProjection } from "@zli-v2/contracts";

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
    <div className="palette-backdrop">
      <button className="dialog-scrim" type="button" aria-label="Close import dialog" onClick={onClose} />
      <section
        className="worktree-dialog legacy-import-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Import legacy workspace"
      >
        <div className="dialog-header">
          <div>
            <span className="eyebrow">Legacy import</span>
            <h2>Review before importing</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        {!preview && state?.status === "scanning" && (
          <div className="import-state">Reading the snapshot without changing legacy data…</div>
        )}
        {!preview && state?.status === "failed" && <div className="import-state import-error">{state.error}</div>}
        {preview && (
          <div className="legacy-import-body">
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
              <p className="import-warning">
                {preview.conflicts.length} conflict(s) require review and will not be imported.
              </p>
            )}
            {preview.sessions.some((session) => session.resume !== "exact") && (
              <p className="import-warning">
                Some provider sessions cannot be resumed exactly; they remain listed for reference.
              </p>
            )}
            <div className="dialog-actions">
              <button className="secondary-button" type="button" onClick={onClose}>
                Cancel
              </button>
              {state?.status === "imported" && (
                <button className="secondary-button" type="button" onClick={onRollback}>
                  Rollback this batch
                </button>
              )}
              <button
                className="primary-button"
                type="button"
                disabled={selected.length === 0 || state?.status === "importing"}
                onClick={() => onImport(selected)}
              >
                {state?.status === "importing" ? "Importing…" : "Import selected"}
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
