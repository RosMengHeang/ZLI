import type { RuntimeProjection, WorktreeProjection } from "@zli-v2/contracts";
import { useRef, useState } from "react";

import { providerDisplayName } from "../agent/providers.js";
import type { RunGroup } from "../sessions/bestOf.js";
import type { AgentSession } from "../sessions/sessions.js";
import { Button } from "../ui/Button.js";
import { Dialog } from "../ui/Dialog.js";

/** A worktree that only this session uses, which deleting the agent may also delete. */
export function deletableWorktree(
  projection: RuntimeProjection,
  sessions: readonly AgentSession[],
  session: AgentSession,
): WorktreeProjection | undefined {
  const worktree = projection.worktrees.find((entry) => entry.worktreeId === session.worktreeId);
  if (!worktree || worktree.kind === "checkout") return undefined;
  const shared = sessions.some(
    (other) => other.sessionId !== session.sessionId && other.worktreeId === session.worktreeId,
  );
  return shared ? undefined : worktree;
}

/** The runs a "Keep this one" deletes, with the worktree branch removed along with each. */
export function discardedRuns(
  projection: RuntimeProjection,
  sessions: readonly AgentSession[],
  group: RunGroup,
  keptSessionId: string,
): { title: string; branch: string | undefined }[] {
  return group.sessionIds.flatMap((sessionId) => {
    const session = sessionId === keptSessionId ? undefined : sessions.find((entry) => entry.sessionId === sessionId);
    if (!session) return [];
    return [
      {
        title: providerDisplayName(session.provider, projection.providers),
        branch: deletableWorktree(projection, sessions, session)?.branch,
      },
    ];
  });
}

export function CloseAgentDialog({
  title,
  provider,
  onStopAndClose,
  onKeepRunning,
  onCancel,
}: {
  title: string;
  provider: string;
  onStopAndClose(): void;
  onKeepRunning(): void;
  onCancel(): void;
}) {
  const stopRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      label="Close agent"
      size="sm"
      title={`${provider} is still running`}
      subtitle={`Stop "${title}" and close its tile, or keep it running in the background. A running agent stays in the sidebar so you can reopen it.`}
      scrimLabel="Cancel"
      showClose={false}
      initialFocusRef={stopRef}
      onClose={onCancel}
    >
      <div className="dialog-footer">
        <Button onClick={onCancel}>Cancel</Button>
        <Button onClick={onKeepRunning}>Keep running</Button>
        <Button variant="primary" ref={stopRef} onClick={onStopAndClose}>
          Stop and close
        </Button>
      </div>
    </Dialog>
  );
}

export function DeleteAgentDialog({
  title,
  provider,
  running,
  worktree,
  onDelete,
  onCancel,
}: {
  title: string;
  provider: string;
  running: boolean;
  worktree: WorktreeProjection | undefined;
  onDelete(removeWorktree: boolean): void;
  onCancel(): void;
}) {
  const [removeWorktree, setRemoveWorktree] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      label="Delete agent"
      size="sm"
      title="Delete this agent?"
      subtitle={`${running ? `Stops ${provider} and removes` : "Removes"} "${title}" from ZLI, with its terminal output and chat history. This cannot be undone.`}
      scrimLabel="Cancel"
      showClose={false}
      initialFocusRef={cancelRef}
      onClose={onCancel}
    >
      {worktree ? (
        <div className="dialog-body">
          <label className="check-field">
            <input
              type="checkbox"
              checked={removeWorktree}
              onChange={(event) => setRemoveWorktree(event.target.checked)}
            />
            <span className="choice-copy">
              <span className="choice-title">Also delete the worktree {worktree.branch}</span>
              <span className="choice-detail" title={worktree.path}>
                Removes the folder {worktree.path}. Uncommitted changes there are lost.
              </span>
            </span>
          </label>
        </div>
      ) : null}
      <div className="dialog-footer">
        <Button ref={cancelRef} onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="danger" onClick={() => onDelete(removeWorktree)}>
          {removeWorktree ? "Delete agent and worktree" : "Delete agent"}
        </Button>
      </div>
    </Dialog>
  );
}

export function KeepRunDialog({
  index,
  count,
  branch,
  discarded,
  onKeep,
  onCancel,
}: {
  index: number;
  count: number;
  branch: string;
  /** The other runs: their agent name and the worktree branch removed with them, if any. */
  discarded: { title: string; branch: string | undefined }[];
  onKeep(): void;
  onCancel(): void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const others = discarded.length === 1 ? "the other run" : `the other ${discarded.length} runs`;
  const removed = discarded.flatMap((run) => (run.branch ? [run.branch] : []));
  return (
    <Dialog
      label="Keep this run"
      size="sm"
      title={`Keep run ${index} of ${count}?`}
      subtitle={`Keeps the agent in ${branch} and deletes ${others}, with their terminal output and chat history. This cannot be undone.`}
      scrimLabel="Cancel"
      showClose={false}
      initialFocusRef={cancelRef}
      onClose={onCancel}
    >
      <div className="dialog-body">
        <ul className="keep-run-list" aria-label="Runs to delete">
          {discarded.map((run, position) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the list is fixed while the dialog is open.
            <li key={position}>
              {run.branch ? <code>{run.branch}</code> : null}
              <span>{run.title}</span>
            </li>
          ))}
        </ul>
        {removed.length > 0 ? (
          <p className="field-hint">
            {removed.length === 1 ? "Its worktree folder is" : "Their worktree folders are"} removed and uncommitted
            changes there are lost. The branches stay in the repository.
          </p>
        ) : null}
      </div>
      <div className="dialog-footer">
        <Button ref={cancelRef} onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="danger" onClick={onKeep}>
          Keep this one
        </Button>
      </div>
    </Dialog>
  );
}
