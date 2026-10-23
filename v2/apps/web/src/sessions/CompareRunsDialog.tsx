import type { RuntimeProjection } from "@zli-v2/contracts";
import { useRef } from "react";

import { providerDisplayName } from "../agent/providers.js";
import { useProjection } from "../runtime/RuntimeProvider.js";
import { Badge, type BadgeTone } from "../ui/Badge.js";
import { Button } from "../ui/Button.js";
import { Dialog } from "../ui/Dialog.js";
import { Icon } from "../ui/Icon.js";
import { ModelMark } from "../ui/ModelMark.js";
import { ProviderMark } from "../ui/ProviderMark.js";
import { formatCost } from "../usage/usage.js";
import {
  type RunGroup,
  type RunState,
  type RunSummary,
  runReplied,
  runState,
  runStateLabel,
  runSummary,
} from "./bestOf.js";
import type { AgentSession } from "./sessions.js";

const stateTone: Record<RunState, BadgeTone> = { running: "info", done: "success", failed: "danger" };

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function checksText(summary: RunSummary): string {
  const checks = summary.checks;
  if (!checks) return "No checks run";
  if (checks.failed === 0) return `${checks.passed} passed`;
  if (checks.passed === 0) return `${checks.failed} failed`;
  return `${checks.passed} passed, ${checks.failed} failed`;
}

/** The runs of one best-of group side by side, so one can be kept. */
export function CompareRunsDialog({
  group,
  sessions,
  onViewDiff,
  onKeep,
  onClose,
}: {
  group: RunGroup;
  sessions: readonly AgentSession[];
  onViewDiff(session: AgentSession): void;
  onKeep(session: AgentSession): void;
  onClose(): void;
}) {
  // The shell projection skips chat-only updates; activities and usage here must be current.
  const projection = useProjection();
  const closeRef = useRef<HTMLButtonElement>(null);
  const runs = group.sessionIds.map((sessionId) => sessions.find((session) => session.sessionId === sessionId));
  return (
    <Dialog
      label="Compare runs"
      className="compare-dialog"
      title={`Compare ${group.sessionIds.length} runs`}
      subtitle={group.prompt.trim().split(/\r?\n/u)[0]}
      initialFocusRef={closeRef}
      onClose={onClose}
    >
      <div className="dialog-body">
        <ol className="compare-runs" style={{ gridTemplateColumns: `repeat(${runs.length}, minmax(0, 1fr))` }}>
          {runs.map((session, index) =>
            projection ? (
              <CompareColumn
                // biome-ignore lint/suspicious/noArrayIndexKey: a column is the run at that position.
                key={index}
                index={index + 1}
                session={session}
                projection={projection}
                onViewDiff={onViewDiff}
                onKeep={onKeep}
              />
            ) : null,
          )}
        </ol>
      </div>
      <div className="dialog-footer">
        <span className="compare-note">Keeping one deletes the other runs, with their worktrees and branches.</span>
        <Button ref={closeRef} onClick={onClose}>
          Close
        </Button>
      </div>
    </Dialog>
  );
}

function CompareColumn({
  index,
  session,
  projection,
  onViewDiff,
  onKeep,
}: {
  index: number;
  session: AgentSession | undefined;
  projection: RuntimeProjection;
  onViewDiff(session: AgentSession): void;
  onKeep(session: AgentSession): void;
}) {
  const thread = session?.thread;
  const state = runState(session, runReplied(projection.messages, thread?.threadId));
  const summary = runSummary(projection, thread?.threadId);
  const worktree = projection.worktrees.find((entry) => entry.worktreeId === session?.worktreeId);
  const name = session ? providerDisplayName(session.provider, projection.providers) : "Deleted";
  const discovery = projection.providers?.find((entry) => entry.provider === session?.provider);
  const listed = discovery?.status === "found" ? discovery.models : undefined;
  const model = thread?.model;
  const modelLabel = model ? (listed?.find((entry) => entry.id === model)?.label ?? model) : "Default model";
  return (
    <li className="compare-run" aria-label={`Run ${index}`}>
      <div className="compare-run-head">
        <span className="compare-run-number">Run {index}</span>
        <Badge tone={stateTone[state]} dot={state !== "running"} spinner={state === "running"}>
          {runStateLabel[state]}
        </Badge>
      </div>
      <div className="compare-run-agent">
        {session ? <ProviderMark provider={session.provider} size={14} /> : null}
        <span>{name}</span>
      </div>
      <div className="compare-run-model">
        <ModelMark id={model} label={modelLabel} size={12} />
        <span>{modelLabel}</span>
      </div>
      {worktree ? (
        <div className="compare-run-branch" title={worktree.path}>
          <Icon name="branch" size={11} />
          <span>{worktree.branch}</span>
        </div>
      ) : null}
      <dl className="compare-stats">
        <div>
          <dt>Files changed</dt>
          <dd>
            {summary.files === 1 ? "1 file" : `${summary.files} files`}
            <span className="compare-lines">
              <span className="is-add">+{summary.additions}</span>
              <span className="is-del">−{summary.deletions}</span>
            </span>
          </dd>
        </div>
        <div>
          <dt>Checks</dt>
          <dd className={summary.checks?.failed ? "is-failed" : undefined}>{checksText(summary)}</dd>
        </div>
        <div>
          <dt>Cost</dt>
          <dd>{summary.costUsd === undefined ? "Not reported" : formatCost(summary.costUsd)}</dd>
        </div>
        <div>
          <dt>Time</dt>
          <dd>{summary.durationMs === undefined ? "Unknown" : formatDuration(summary.durationMs)}</dd>
        </div>
      </dl>
      <div className="compare-run-actions">
        <Button
          variant="ghost"
          size="sm"
          icon="diff"
          disabled={!session || !worktree}
          onClick={() => session && onViewDiff(session)}
        >
          View diff
        </Button>
        <Button
          variant="primary"
          size="sm"
          icon="check"
          disabled={!session || state === "running"}
          tooltip={state === "running" ? "Wait for this run to finish" : undefined}
          onClick={() => session && onKeep(session)}
        >
          Keep this one
        </Button>
      </div>
    </li>
  );
}
