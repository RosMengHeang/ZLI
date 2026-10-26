import type { GitStash, GitStashAction } from "@zli-v2/contracts";
import { useCallback, useEffect, useState } from "react";

import { useRuntime } from "../runtime/RuntimeProvider.js";
import { Button } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { listStashes, runStashAction, stashChanges } from "./pullRequestClient.js";

const actionLabels: Record<GitStashAction, { label: string; tooltip: string }> = {
  apply: { label: "Apply", tooltip: "Apply the stash to the working tree and keep it in the list" },
  pop: { label: "Pop", tooltip: "Apply the stash to the working tree and remove it from the list" },
  drop: { label: "Drop", tooltip: "Delete the stash without applying it" },
};

function stashName(stash: GitStash): string {
  return `stash@{${stash.index}}`;
}

/** A disclosure with Stash changes and the repository's stashes, each with Apply, Pop, and Drop. */
export function StashSection({
  worktreeId,
  hasChanges,
  disabled = false,
  onChanged,
}: {
  worktreeId: string;
  hasChanges: boolean;
  disabled?: boolean;
  /** Called after the working tree may have changed, with what to tell the person. */
  onChanged(notice: string): void;
}) {
  const { dispatch } = useRuntime();
  const [open, setOpen] = useState(false);
  const [stashes, setStashes] = useState<GitStash[]>();
  const [message, setMessage] = useState("");
  const [running, setRunning] = useState<string>();
  const [error, setError] = useState<string>();
  const [dropping, setDropping] = useState<GitStash>();

  const load = useCallback(async () => {
    try {
      setStashes((await listStashes(dispatch, worktreeId)).stashes);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The stashes could not be listed.");
    }
  }, [dispatch, worktreeId]);

  useEffect(() => {
    setStashes(undefined);
    setError(undefined);
    void load();
  }, [load]);

  const stash = async () => {
    setRunning("stash");
    setError(undefined);
    try {
      const result = await stashChanges(dispatch, worktreeId, message.trim() || undefined);
      setStashes(result.stashes);
      if (result.created) setMessage("");
      onChanged(result.created ? "Stashed the changes, untracked files included." : "There were no changes to stash.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The changes could not be stashed.");
    } finally {
      setRunning(undefined);
    }
  };

  const act = async (action: GitStashAction, target: GitStash) => {
    setRunning(`${action}:${target.commit}`);
    setError(undefined);
    try {
      const result = await runStashAction(dispatch, worktreeId, {
        action,
        index: target.index,
        commit: target.commit,
      });
      setStashes(result.stashes);
      setDropping(undefined);
      const name = stashName(target);
      onChanged(
        result.conflicted
          ? `${name} applied with conflicts. Resolve them, then stage the files.${action === "pop" ? " The stash was kept." : ""}`
          : action === "apply"
            ? `Applied ${name}. It stays in the list.`
            : action === "pop"
              ? `Applied ${name} and removed it from the list.`
              : `Dropped ${name}.`,
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : `The stash could not be ${action === "drop" ? "dropped" : "applied"}.`,
      );
      setDropping(undefined);
      void load();
    } finally {
      setRunning(undefined);
    }
  };

  const count = stashes?.length;
  const blocked = disabled || !!running;
  return (
    <div className="review-stash">
      <button
        type="button"
        className="review-stash-toggle"
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
          if (!open) void load();
        }}
      >
        <Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
        <span>Stashes{count === undefined ? "" : ` (${count})`}</span>
      </button>
      {open ? (
        <div className="review-stash-body">
          <form
            className="review-stash-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (hasChanges && !blocked) void stash();
            }}
          >
            <input
              className="input input-sm"
              aria-label="Stash message"
              placeholder="Stash message (optional)"
              value={message}
              maxLength={500}
              onChange={(event) => setMessage(event.target.value)}
            />
            <Button
              size="sm"
              type="submit"
              loading={running === "stash"}
              disabled={blocked || !hasChanges}
              tooltip={
                hasChanges
                  ? "Set aside every change, untracked files included, and leave the working tree clean"
                  : "There are no uncommitted changes to stash"
              }
            >
              Stash changes
            </Button>
          </form>
          {stashes && stashes.length > 0 ? (
            <ul className="review-stash-list">
              {stashes.map((item) => (
                <li className="review-stash-item" key={item.commit}>
                  <span className="review-stash-name">{stashName(item)}</span>
                  <span className="review-stash-message" title={item.message}>
                    {item.message || "No message"}
                  </span>
                  {item.branch ? <span className="review-stash-branch">{item.branch}</span> : null}
                  {(Object.keys(actionLabels) as GitStashAction[]).map((action) => (
                    <Button
                      key={action}
                      size="xs"
                      variant="ghost"
                      className={action === "drop" ? "is-danger" : undefined}
                      aria-label={`${actionLabels[action].label} ${stashName(item)}`}
                      tooltip={actionLabels[action].tooltip}
                      loading={running === `${action}:${item.commit}`}
                      disabled={blocked}
                      onClick={() => (action === "drop" ? setDropping(item) : void act(action, item))}
                    >
                      {actionLabels[action].label}
                    </Button>
                  ))}
                </li>
              ))}
            </ul>
          ) : stashes ? (
            <p className="review-stash-note">No stashes yet.</p>
          ) : null}
          <p className="review-stash-note">Stashes belong to the repository, so every worktree shows the same list.</p>
        </div>
      ) : null}
      {error ? (
        <p className="inline-error review-stash-error" role="alert">
          <Icon name="alert" size={13} />
          <span>{error}</span>
        </p>
      ) : null}
      {dropping ? (
        <ConfirmDialog
          label="Drop stash"
          title={`Drop ${stashName(dropping)}?`}
          detail={`Deletes the stash "${dropping.message || stashName(dropping)}" without applying it. This cannot be undone.`}
          confirmLabel="Drop stash"
          busy={running === `drop:${dropping.commit}`}
          onConfirm={() => void act("drop", dropping)}
          onCancel={() => setDropping(undefined)}
        />
      ) : null}
    </div>
  );
}
