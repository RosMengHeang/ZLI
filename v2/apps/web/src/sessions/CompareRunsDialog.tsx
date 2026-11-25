import type { CheckpointDiffResult, RuntimeProjection, WorktreeProjection } from "@zli-v2/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { providerDisplayName } from "../agent/providers.js";
import { readCheckpointDiff } from "../chat/checkpointClient.js";
import { Markdown } from "../chat/Markdown.js";
import { DiffView } from "../review/DiffView.js";
import { makeCommandId } from "../runtime/commandId.js";
import { useProjection, useRuntime } from "../runtime/RuntimeProvider.js";
import { Badge, type BadgeTone } from "../ui/Badge.js";
import { Button, IconButton } from "../ui/Button.js";
import { Dialog } from "../ui/Dialog.js";
import { Field } from "../ui/Field.js";
import { Icon } from "../ui/Icon.js";
import { ModelMark } from "../ui/ModelMark.js";
import { ProviderMark } from "../ui/ProviderMark.js";
import { formatCost, formatTokens } from "../usage/usage.js";
import {
  type RunGroup,
  type RunState,
  type RunSummary,
  runReplied,
  runState,
  runStateLabel,
  runSummary,
} from "./bestOf.js";
import {
  type FileMatrixRow,
  fileMatrix,
  finalReply,
  type PartPicks,
  partsToBring,
  type RunFile,
  runFiles,
  runTokens,
} from "./compareRuns.js";
import {
  detectDevCommand,
  type PreviewState,
  previewState,
  previewTerminalCommand,
  savedPreviewCommand,
  savePreviewCommand,
} from "./runPreview.js";
import type { AgentSession } from "./sessions.js";
import "./compare.css";

const stateTone: Record<RunState, BadgeTone> = { running: "info", done: "success", failed: "danger" };

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function checksText(summary: RunSummary): string | undefined {
  const checks = summary.checks;
  if (!checks) return undefined;
  if (checks.failed === 0) return `${checks.passed} passed`;
  if (checks.passed === 0) return `${checks.failed} failed`;
  return `${checks.passed} passed, ${checks.failed} failed`;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** Files from other runs to copy into the kept run before the others are deleted. */
export type KeepParts = { from: AgentSession; paths: string[] }[];

type RunView = {
  index: number;
  session: AgentSession | undefined;
  state: RunState;
  summary: RunSummary;
  files: RunFile[];
  worktree: WorktreeProjection | undefined;
  name: string;
  model: string | undefined;
  modelLabel: string;
  reply: string | undefined;
  tokens: number | undefined;
};

function runViews(projection: RuntimeProjection, group: RunGroup, sessions: readonly AgentSession[]): RunView[] {
  return group.sessionIds.map((sessionId, position) => {
    const session = sessions.find((entry) => entry.sessionId === sessionId);
    const threadId = session?.thread?.threadId;
    const discovery = projection.providers?.find((entry) => entry.provider === session?.provider);
    const listed = discovery?.status === "found" ? discovery.models : undefined;
    const model = session?.thread?.model;
    return {
      index: position + 1,
      session,
      state: runState(session, runReplied(projection.messages, threadId)),
      summary: runSummary(projection, threadId),
      files: runFiles(projection.checkpoints, threadId),
      worktree: projection.worktrees.find((entry) => entry.worktreeId === session?.worktreeId),
      name: session ? providerDisplayName(session.provider, projection.providers) : "Deleted",
      model,
      modelLabel: model ? (listed?.find((entry) => entry.id === model)?.label ?? model) : "Default model",
      reply: finalReply(projection.messages, threadId),
      tokens: runTokens(projection.usage, threadId),
    };
  });
}

type Selection = { runIndex: number; path: string };

/**
 * The runs of one best-of group side by side, with a table of the files each one changed. One run can be kept
 * as it is, or kept with files brought in from the others.
 */
export function CompareRunsDialog({
  group,
  sessions,
  onViewDiff,
  onKeep,
  onKeepParts,
  onOpenPreview,
  onClose,
}: {
  group: RunGroup;
  sessions: readonly AgentSession[];
  onViewDiff(session: AgentSession): void;
  onKeep(session: AgentSession): void;
  onKeepParts(session: AgentSession, parts: KeepParts): void;
  onOpenPreview(session: AgentSession, url: string): void;
  onClose(): void;
}) {
  // The shell projection skips chat-only updates; activities and usage here must be current.
  const projection = useProjection();
  const { dispatch } = useRuntime();
  const closeRef = useRef<HTMLButtonElement>(null);
  const runs = useMemo(() => (projection ? runViews(projection, group, sessions) : []), [projection, group, sessions]);
  const rows = useMemo(() => fileMatrix(runs.map((run) => run.files)), [runs]);
  const [selected, setSelected] = useState<Selection>();
  const [parts, setParts] = useState<{ keptIndex: number; picks: Map<string, number> }>();
  const [previewTerminals, setPreviewTerminals] = useState<ReadonlyMap<number, string>>(new Map());
  const [previewErrors, setPreviewErrors] = useState<ReadonlyMap<number, string>>(new Map());
  /** Asking for the preview command: to start a run's preview, or only to change the saved command. */
  const [askCommand, setAskCommand] = useState<{ run?: RunView; initial: string }>();
  const projectId = runs.find((run) => run.worktree)?.worktree?.projectId;
  const [chosenCommand, setCommand] = useState<string>();
  const command = chosenCommand ?? (projectId ? savedPreviewCommand(projectId) : undefined);

  // A run's preview starts once at a time: a second click during the command lookup or the start is ignored, so two
  // installs never race in one worktree.
  const starting = useRef(new Set<number>());
  const [startingRuns, setStartingRuns] = useState<ReadonlySet<number>>(new Set());
  const markStarting = (index: number, on: boolean) => {
    if (on) starting.current.add(index);
    else starting.current.delete(index);
    setStartingRuns(new Set(starting.current));
  };

  const startPreview = async (run: RunView, chosen?: string) => {
    if (starting.current.has(run.index)) return;
    markStarting(run.index, true);
    try {
      await launchPreview(run, chosen);
    } finally {
      markStarting(run.index, false);
    }
  };

  const launchPreview = async (run: RunView, chosen?: string) => {
    const worktree = run.worktree;
    if (worktree?.status !== "ready") return;
    setPreviewErrors((current) => without(current, run.index));
    let text = chosen ?? command ?? savedPreviewCommand(worktree.projectId);
    if (!text) text = await detectDevCommand(dispatch, worktree.worktreeId);
    if (!text) {
      setAskCommand({ run, initial: "" });
      return;
    }
    savePreviewCommand(worktree.projectId, text);
    setCommand(text);
    const request = previewTerminalCommand(text, worktree, `Preview, run ${run.index}`);
    try {
      const response = await dispatch({ protocolVersion: 1, commandId: makeCommandId(), command: request });
      if (!response) throw new Error("The runtime is not connected.");
      if (!response.accepted) throw new Error(response.error.message);
      setPreviewTerminals((current) => new Map(current).set(run.index, request.terminalId));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "The preview could not start.";
      setPreviewErrors((current) => new Map(current).set(run.index, message));
    }
  };

  const keptRun = parts ? runs[parts.keptIndex - 1] : undefined;
  const bring = parts ? partsToBring(parts.picks, parts.keptIndex) : [];
  const bringCount = bring.reduce((sum, entry) => sum + entry.paths.length, 0);
  const pick = (path: string, runIndex: number) =>
    setParts((current) => current && { ...current, picks: new Map(current.picks).set(path, runIndex) });

  return (
    <Dialog
      label="Compare runs"
      className="runs-compare-dialog"
      size="lg"
      title={`Compare ${group.sessionIds.length} runs`}
      subtitle={group.prompt.trim().split(/\r?\n/u)[0]}
      initialFocusRef={closeRef}
      onClose={onClose}
    >
      <div className="dialog-body runs-compare-body">
        <ol className="runs-compare-columns" aria-label="Runs">
          {runs.map((run) => (
            <RunColumn
              key={run.index}
              run={run}
              preview={
                projection
                  ? previewState(
                      projection.devServers,
                      projection.terminals,
                      run.worktree?.worktreeId,
                      previewTerminals.get(run.index),
                    )
                  : { kind: "idle" }
              }
              previewError={previewErrors.get(run.index)}
              previewStarting={startingRuns.has(run.index)}
              selectedPath={selected?.runIndex === run.index ? selected.path : undefined}
              partsMode={parts !== undefined}
              onSelectFile={(path) => setSelected({ runIndex: run.index, path })}
              onPreview={() => void startPreview(run)}
              onOpenPreview={(url) => run.session && onOpenPreview(run.session, url)}
              onViewDiff={() => run.session && onViewDiff(run.session)}
              onKeep={() => run.session && onKeep(run.session)}
              onKeepParts={() => {
                setSelected(undefined);
                setParts({ keptIndex: run.index, picks: new Map() });
              }}
            />
          ))}
        </ol>

        <section className="runs-compare-section" aria-labelledby="runs-compare-files">
          <h3 id="runs-compare-files" className="runs-compare-heading">
            Files changed
          </h3>
          {parts && keptRun ? (
            <p className="runs-compare-hint">
              Keeping run {keptRun.index}. For each file, pick the run whose version to keep.
            </p>
          ) : rows.length > 0 ? (
            <p className="runs-compare-hint">Pick a cell to see that run's diff of the file.</p>
          ) : null}
          {rows.length === 0 ? (
            <p className="runs-compare-empty">No run has changed any files yet.</p>
          ) : (
            <FileMatrix
              runs={runs}
              rows={rows}
              selected={selected}
              parts={parts}
              onSelect={setSelected}
              onPick={pick}
            />
          )}
        </section>

        {selected && !parts ? (
          <RunDiff run={runs[selected.runIndex - 1]} path={selected.path} onClose={() => setSelected(undefined)} />
        ) : null}
      </div>
      <div className="dialog-footer runs-compare-footer">
        {parts && keptRun ? (
          <>
            <span className="runs-compare-note">
              {bringCount === 0
                ? `Run ${keptRun.index} stays as it is.`
                : `${plural(bringCount, "file")} from other runs go into run ${keptRun.index}.`}{" "}
              The other runs are deleted after you confirm.
            </span>
            <Button onClick={() => setParts(undefined)}>Cancel</Button>
            <Button
              variant="primary"
              icon="check"
              disabled={!keptRun.session}
              onClick={() => {
                const kept = keptRun.session;
                if (!kept) return;
                onKeepParts(
                  kept,
                  bring.flatMap(({ runIndex, paths }) => {
                    const from = runs[runIndex - 1]?.session;
                    return from ? [{ from, paths }] : [];
                  }),
                );
              }}
            >
              Keep run {keptRun.index}
            </Button>
          </>
        ) : (
          <>
            <span className="runs-compare-note">
              {command ? (
                <>
                  Preview runs <code>{command}</code>.{" "}
                  <button
                    type="button"
                    className="runs-compare-link"
                    onClick={() => setAskCommand({ initial: command })}
                  >
                    Change
                  </button>
                </>
              ) : (
                "Keeping one deletes the other runs, with their worktrees and branches."
              )}
            </span>
            <Button ref={closeRef} onClick={onClose}>
              Close
            </Button>
          </>
        )}
      </div>
      {askCommand ? (
        <PreviewCommandDialog
          initial={askCommand.initial}
          onCancel={() => setAskCommand(undefined)}
          onSubmit={(text) => {
            const run = askCommand.run;
            setAskCommand(undefined);
            if (run) void startPreview(run, text);
            else if (projectId) {
              savePreviewCommand(projectId, text);
              setCommand(text);
            }
          }}
        />
      ) : null}
    </Dialog>
  );
}

function without<T>(map: ReadonlyMap<number, T>, key: number): ReadonlyMap<number, T> {
  if (!map.has(key)) return map;
  const next = new Map(map);
  next.delete(key);
  return next;
}

function Lines({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="runs-compare-lines">
      <span className="is-add">+{additions}</span>
      <span className="is-del">−{deletions}</span>
    </span>
  );
}

function RunColumn({
  run,
  preview,
  previewError,
  previewStarting,
  selectedPath,
  partsMode,
  onSelectFile,
  onPreview,
  onOpenPreview,
  onViewDiff,
  onKeep,
  onKeepParts,
}: {
  run: RunView;
  preview: PreviewState;
  previewError: string | undefined;
  /** Its preview command is being looked up or started. */
  previewStarting: boolean;
  selectedPath: string | undefined;
  partsMode: boolean;
  onSelectFile(path: string): void;
  onPreview(): void;
  onOpenPreview(url: string): void;
  onViewDiff(): void;
  onKeep(): void;
  onKeepParts(): void;
}) {
  const { session, state, summary, worktree } = run;
  const checks = checksText(summary);
  const running = state === "running";
  const ready = worktree?.status === "ready";
  const failedMessage = previewError ?? (preview.kind === "failed" ? preview.message : undefined);
  return (
    <li className="runs-compare-run" aria-label={`Run ${run.index}`}>
      <div className="runs-compare-run-head">
        <span className="runs-compare-run-number">Run {run.index}</span>
        <Badge tone={stateTone[state]} dot={!running} spinner={running}>
          {running ? "Working" : runStateLabel[state]}
        </Badge>
      </div>
      <div className="runs-compare-agent">
        {session ? <ProviderMark provider={session.provider} size={14} /> : null}
        <span>{run.name}</span>
        <span className="runs-compare-sep" aria-hidden="true">
          ·
        </span>
        <ModelMark id={run.model} label={run.modelLabel} agent={session?.provider} size={12} />
        <span className="runs-compare-model">{run.modelLabel}</span>
      </div>
      {worktree ? (
        <div className="runs-compare-branch" title={worktree.path}>
          <Icon name="branch" size={11} />
          <span>{worktree.branch}</span>
        </div>
      ) : null}
      <dl className="runs-compare-stats">
        <div>
          <dt>Time</dt>
          <dd>{summary.durationMs === undefined ? "Unknown" : formatDuration(summary.durationMs)}</dd>
        </div>
        <div>
          <dt>Cost</dt>
          <dd>{summary.costUsd === undefined ? "Not reported" : formatCost(summary.costUsd)}</dd>
        </div>
        <div>
          <dt>Tokens</dt>
          <dd>{run.tokens === undefined ? "Not reported" : formatTokens(run.tokens)}</dd>
        </div>
        <div>
          <dt>Changes</dt>
          <dd>
            {plural(summary.files, "file")}
            <Lines additions={summary.additions} deletions={summary.deletions} />
          </dd>
        </div>
        {checks ? (
          <div>
            <dt>Checks</dt>
            <dd className={summary.checks?.failed ? "is-failed" : "is-passed"}>{checks}</dd>
          </div>
        ) : null}
      </dl>
      <section className="runs-compare-summary" aria-label={`Run ${run.index} summary`}>
        {run.reply ? (
          <Markdown text={run.reply} />
        ) : (
          <p className="runs-compare-empty">{running ? "No reply yet." : "No reply."}</p>
        )}
      </section>
      {run.files.length > 0 ? (
        <ul className="runs-compare-files" aria-label={`Files run ${run.index} changed`}>
          {run.files.map((file) => (
            <li key={file.path}>
              <button
                type="button"
                className={`runs-compare-file${selectedPath === file.path ? " is-selected" : ""}`}
                title={file.path}
                disabled={partsMode}
                onClick={() => onSelectFile(file.path)}
              >
                <span className="runs-compare-file-path">{file.path}</span>
                {file.binary ? (
                  <span className="runs-compare-file-kind">binary</span>
                ) : (
                  <Lines additions={file.additions} deletions={file.deletions} />
                )}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {failedMessage ? (
        <p className="runs-compare-error" role="alert">
          {failedMessage}
        </p>
      ) : null}
      <div className="runs-compare-actions">
        {preview.kind === "ready" ? (
          <Button size="sm" icon="globe" tooltip={preview.url} onClick={() => onOpenPreview(preview.url)}>
            Open preview
          </Button>
        ) : (
          <Button
            size="sm"
            icon="play"
            variant="ghost"
            loading={preview.kind === "starting" || previewStarting}
            disabled={!session || !ready || partsMode || previewStarting}
            tooltip="Start this run's app in its worktree"
            onClick={onPreview}
          >
            {preview.kind === "starting" || previewStarting ? "Starting" : "Preview"}
          </Button>
        )}
        <Button size="sm" variant="ghost" icon="diff" disabled={!session || !worktree} onClick={onViewDiff}>
          Review
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!session || running || partsMode}
          tooltip={running ? "Wait for this run to finish" : "Keep this run and bring in files from the others"}
          onClick={onKeepParts}
        >
          Keep parts
        </Button>
        <Button
          variant="primary"
          size="sm"
          icon="check"
          disabled={!session || running || partsMode}
          tooltip={running ? "Wait for this run to finish" : undefined}
          onClick={onKeep}
        >
          Keep this one
        </Button>
      </div>
    </li>
  );
}

function cellLabel(file: RunFile | undefined): string {
  if (!file) return "not changed";
  if (file.binary) return `${file.kind}, binary`;
  return `${file.additions} added, ${file.deletions} removed`;
}

function FileMatrix({
  runs,
  rows,
  selected,
  parts,
  onSelect,
  onPick,
}: {
  runs: readonly RunView[];
  rows: readonly FileMatrixRow[];
  selected: Selection | undefined;
  parts: { keptIndex: number; picks: PartPicks } | undefined;
  onSelect(selection: Selection): void;
  onPick(path: string, runIndex: number): void;
}) {
  return (
    <div className="runs-compare-matrix-scroll">
      <table className="runs-compare-matrix">
        <thead>
          <tr>
            <th scope="col">File</th>
            {runs.map((run) => (
              <th key={run.index} scope="col" className={parts?.keptIndex === run.index ? "is-kept" : undefined}>
                <span className="runs-compare-matrix-run">Run {run.index}</span>
                <span className="runs-compare-matrix-agent">{run.name}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.path} className={row.touchedBy > 1 ? "is-shared" : undefined}>
              <th scope="row" title={row.path}>
                <span className="runs-compare-matrix-path">{row.path}</span>
              </th>
              {row.cells.map((file, position) => {
                const run = runs[position];
                if (!run) return null;
                const label = `Run ${run.index}, ${row.path}: ${cellLabel(file)}`;
                if (parts) {
                  const picked = (parts.picks.get(row.path) ?? parts.keptIndex) === run.index;
                  const kept = run.index === parts.keptIndex;
                  const canPick = kept || (file !== undefined && run.state !== "running" && run.session !== undefined);
                  return (
                    <td key={run.index} className={kept ? "is-kept" : undefined}>
                      {canPick ? (
                        <label className={`runs-compare-pick${picked ? " is-picked" : ""}`}>
                          <input
                            type="radio"
                            name={`pick-${row.path}`}
                            checked={picked}
                            aria-label={kept ? `Keep run ${run.index}'s ${row.path}` : `Use ${label}`}
                            onChange={() => onPick(row.path, run.index)}
                          />
                          {file ? (
                            <Lines additions={file.additions} deletions={file.deletions} />
                          ) : (
                            <span className="runs-compare-cell-none">as is</span>
                          )}
                        </label>
                      ) : (
                        <span className="runs-compare-cell-none" title={label}>
                          <span aria-hidden="true">–</span>
                          <span className="runs-compare-sr">{label}</span>
                        </span>
                      )}
                    </td>
                  );
                }
                const isSelected = selected?.runIndex === run.index && selected.path === row.path;
                return (
                  <td key={run.index}>
                    {file ? (
                      <button
                        type="button"
                        className={`runs-compare-cell${isSelected ? " is-selected" : ""}`}
                        aria-label={label}
                        aria-pressed={isSelected}
                        onClick={() => onSelect({ runIndex: run.index, path: row.path })}
                      >
                        {file.binary ? (
                          <span className="runs-compare-file-kind">binary</span>
                        ) : (
                          <Lines additions={file.additions} deletions={file.deletions} />
                        )}
                      </button>
                    ) : (
                      <span className="runs-compare-cell-none" title={label}>
                        <span aria-hidden="true">–</span>
                        <span className="runs-compare-sr">{label}</span>
                      </span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type DiffLoad =
  | { state: "loading" }
  | { state: "ready"; diff: CheckpointDiffResult }
  | { state: "error"; message: string };

/** One run's diff of one file, across every turn of the run that changed it. */
function RunDiff({ run, path, onClose }: { run: RunView | undefined; path: string; onClose(): void }) {
  const { dispatch } = useRuntime();
  const file = run?.files.find((entry) => entry.path === path);
  const [load, setLoad] = useState<DiffLoad>({ state: "loading" });
  const ref = useRef<HTMLElement>(null);
  const first = file?.firstCheckpointId;
  const last = file?.lastCheckpointId;
  useEffect(() => {
    if (!first) return;
    let current = true;
    setLoad({ state: "loading" });
    readCheckpointDiff(dispatch, first, path, last)
      .then((diff) => current && setLoad({ state: "ready", diff }))
      .catch(
        (cause) =>
          current &&
          setLoad({ state: "error", message: cause instanceof Error ? cause.message : "The diff could not load." }),
      );
    return () => {
      current = false;
    };
  }, [dispatch, first, last, path]);
  useEffect(() => {
    ref.current?.scrollIntoView?.({ block: "nearest" });
  }, []);
  if (!run || !file) return null;
  return (
    <section ref={ref} className="runs-compare-section runs-compare-diff" aria-label={`Run ${run.index} diff`}>
      <div className="runs-compare-diff-head">
        <h3 className="runs-compare-heading">
          Run {run.index} · {run.name}
        </h3>
        <IconButton label="Close diff" icon="x" size="sm" onClick={onClose} />
      </div>
      {load.state === "loading" ? (
        <p className="runs-compare-empty">Loading the diff.</p>
      ) : load.state === "error" ? (
        <p className="runs-compare-error" role="alert">
          {load.message}
        </p>
      ) : (
        <DiffView worktreeId={run.worktree?.worktreeId ?? ""} diff={load.diff} />
      )}
    </section>
  );
}

function PreviewCommandDialog({
  initial,
  onCancel,
  onSubmit,
}: {
  initial: string;
  onCancel(): void;
  onSubmit(command: string): void;
}) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <Dialog
      label="Preview command"
      size="sm"
      title="How does this project start?"
      subtitle="ZLI runs this in each run's worktree and opens the address it prints. It is saved for this project."
      initialFocusRef={inputRef}
      stacked
      onClose={onCancel}
    >
      <form
        className="dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (value.trim()) onSubmit(value.trim());
        }}
      >
        <div className="dialog-body">
          <Field label="Command" hint="Start with the install step, since a new worktree has no packages yet.">
            <input
              ref={inputRef}
              className="input"
              value={value}
              placeholder="npm install && npm run dev"
              spellCheck={false}
              onChange={(event) => setValue(event.target.value)}
            />
          </Field>
        </div>
        <div className="dialog-footer">
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={!value.trim()}>
            Start preview
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
