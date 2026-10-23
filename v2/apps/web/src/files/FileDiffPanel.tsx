import type { ThreadCheckpoint } from "@zli-v2/contracts";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";

import { readCheckpointDiff } from "../chat/checkpointClient.js";
import { DiffView } from "../review/DiffView.js";
import "../review/review.css";
import { useRuntime } from "../runtime/RuntimeProvider.js";
import { Button } from "../ui/Button.js";
import { EmptyState, LoadingState } from "../ui/Pane.js";
import { readFileDiff } from "./fileClient.js";

export type DiffSource = "uncommitted" | "turn";

type DiffState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; patch: string; binary: boolean; truncated: boolean };

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//u, "");
}

/** The newest agent turn in this worktree that changed `path`, with that file's path as the turn recorded it. */
export function latestTurnFor(
  checkpoints: readonly ThreadCheckpoint[] | undefined,
  worktreeId: string,
  path: string,
): { checkpoint: ThreadCheckpoint; path: string } | undefined {
  if (!checkpoints) return undefined;
  for (let index = checkpoints.length - 1; index >= 0; index -= 1) {
    const checkpoint = checkpoints[index];
    if (checkpoint?.worktreeId !== worktreeId) continue;
    const file = checkpoint.files.find((candidate) => normalizePath(candidate.path) === path);
    if (file) return { checkpoint, path: file.path };
  }
  return undefined;
}

const SOURCES: { value: DiffSource; label: string }[] = [
  { value: "uncommitted", label: "Last commit" },
  { value: "turn", label: "Last turn" },
];

/** The open file's diff, against the last commit or against the start of the latest agent turn that changed it. */
export function FileDiffPanel({
  worktreeId,
  path,
  revision,
  turn,
  source,
  onSourceChange,
  onOpenChanges,
}: {
  worktreeId: string;
  path: string;
  /** Changes whenever the file or its Git state changes, so the diff reloads. */
  revision: string;
  turn: { checkpoint: ThreadCheckpoint; path: string } | undefined;
  source: DiffSource;
  onSourceChange(source: DiffSource): void;
  /** Opens the file in the Changes panel, which compares with the base branch. */
  onOpenChanges(): void;
}) {
  const { dispatch } = useRuntime();
  const active: DiffSource = source === "turn" && turn ? "turn" : "uncommitted";
  const turnKey = turn ? `${turn.checkpoint.checkpointId}:${turn.path}` : "";
  const target = `${active}:${path}:${active === "turn" ? turnKey : ""}`;
  const [state, setState] = useState<{ target: string; diff: DiffState }>({ target, diff: { status: "loading" } });
  const [attempt, setAttempt] = useState(0);
  const labelId = useId();
  const panelId = useId();
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the target, revision, and retry attempt decide when to reload.
  useEffect(() => {
    let cancelled = false;
    // A reload of the same diff keeps showing the old one until the new one arrives.
    setState((current) => (current.target === target ? current : { target, diff: { status: "loading" } }));
    const request =
      active === "turn" && turn
        ? readCheckpointDiff(dispatch, turn.checkpoint.checkpointId, turn.path)
        : readFileDiff(dispatch, worktreeId, path);
    request.then(
      (result) => {
        if (cancelled) return;
        setState({
          target,
          diff: { status: "ready", patch: result.patch, binary: result.binary, truncated: result.truncated },
        });
      },
      (cause: unknown) => {
        if (cancelled) return;
        setState({
          target,
          diff: { status: "error", message: cause instanceof Error ? cause.message : "The diff could not be read." },
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [target, revision, attempt]);

  const choose = (value: DiffSource, index: number) => {
    if (value === "turn" && !turn) return;
    onSourceChange(value);
    tabs.current[index]?.focus();
  };
  const onTabKey = (event: KeyboardEvent, index: number) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const enabled = SOURCES.flatMap((item, position) => (item.value === "turn" && !turn ? [] : [position]));
    const at = enabled.indexOf(index);
    const next =
      event.key === "Home"
        ? enabled[0]
        : event.key === "End"
          ? enabled.at(-1)
          : enabled[(at + (event.key === "ArrowRight" ? 1 : enabled.length - 1)) % enabled.length];
    const item = next === undefined ? undefined : SOURCES[next];
    if (item && next !== undefined) choose(item.value, next);
  };

  const diff = state.target === target ? state.diff : { status: "loading" as const };
  const turnTime = turn?.checkpoint.recordedAt ? new Date(turn.checkpoint.recordedAt).toLocaleString() : undefined;

  return (
    <section className="file-diff" aria-label={`Changes to ${path}`}>
      <div className="file-diff-bar">
        <span className="file-diff-label" id={labelId}>
          Compare with
        </span>
        <div className="file-view-tabs" role="tablist" aria-labelledby={labelId}>
          {SOURCES.map((item, index) => {
            const unavailable = item.value === "turn" && !turn;
            return (
              <button
                key={item.value}
                ref={(element) => {
                  tabs.current[index] = element;
                }}
                className={item.value === active ? "is-active" : undefined}
                type="button"
                role="tab"
                aria-selected={item.value === active}
                aria-controls={panelId}
                aria-disabled={unavailable || undefined}
                tabIndex={item.value === active ? 0 : -1}
                title={
                  item.value === "uncommitted"
                    ? "Changes since the last commit"
                    : unavailable
                      ? "No agent turn in this worktree changed this file"
                      : `What the latest agent turn that touched this file changed${turnTime ? `, ${turnTime}` : ""}`
                }
                onClick={() => choose(item.value, index)}
                onKeyDown={(event) => onTabKey(event, index)}
              >
                {item.label}
              </button>
            );
          })}
        </div>
        <span className="file-path-spacer" />
        <Button
          variant="ghost"
          size="sm"
          tooltip="Compare with the base branch in the Changes panel"
          onClick={onOpenChanges}
        >
          Open in Changes
        </Button>
      </div>
      <div className="file-diff-body" id={panelId} role="tabpanel" aria-labelledby={labelId}>
        {diff.status === "loading" ? (
          <LoadingState label="Loading the diff" />
        ) : diff.status === "error" ? (
          <EmptyState icon="alert" tone="danger" title="The diff could not be read" detail={diff.message}>
            <Button icon="reload" onClick={() => setAttempt((value) => value + 1)}>
              Try again
            </Button>
          </EmptyState>
        ) : diff.binary ? (
          <EmptyState icon="file" title="Binary file" detail="There is no text diff to show." />
        ) : !diff.patch.trim() ? (
          active === "uncommitted" ? (
            <EmptyState icon="check" title="No uncommitted changes" detail="This file matches the last commit." />
          ) : (
            <EmptyState
              icon="file"
              title="Only the name or file mode changed"
              detail="The turn did not change any lines."
            />
          )
        ) : (
          <DiffView
            worktreeId={worktreeId}
            diff={{ path, patch: diff.patch.replace(/\r?\n$/u, ""), binary: false, truncated: diff.truncated }}
          />
        )}
      </div>
    </section>
  );
}
