import type { GitBranchesResult, GitLocalBranch, WorktreeProjection } from "@zli-v2/contracts";
import { type KeyboardEvent, useId, useMemo, useRef, useState } from "react";

import { useRuntime } from "../runtime/RuntimeProvider.js";
import { Badge } from "../ui/Badge.js";
import { Button } from "../ui/Button.js";
import { Dialog } from "../ui/Dialog.js";
import { Field, Select } from "../ui/Field.js";
import { Icon } from "../ui/Icon.js";
import type { PickerOption } from "../ui/Picker.js";
import { Switch } from "../ui/Switch.js";
import { trackDescription, trackText } from "./branches.js";
import { createBranch, deleteBranch, renameBranch, switchBranch } from "./pullRequestClient.js";

type Row = { key: string; name: string; local: boolean; onOrigin: boolean; detail: GitLocalBranch | undefined };
type View = { kind: "list" } | { kind: "create" } | { kind: "rename"; from: string } | { kind: "delete"; row: Row };

/** What the person can do with a branch row, and why not when they cannot. */
export function branchRows(branches: GitBranchesResult | undefined, query = ""): Row[] {
  if (!branches) return [];
  const needle = query.trim().toLowerCase();
  const matches = (name: string) => !needle || name.toLowerCase().includes(needle);
  const local = branches.current
    ? [branches.current, ...branches.local.filter((name) => name !== branches.current)]
    : branches.local;
  const rows: Row[] = local.filter(matches).map((name) => ({
    key: name,
    name,
    local: true,
    onOrigin: branches.remote.includes(name),
    detail: branches.details?.[name],
  }));
  for (const name of branches.remote) {
    if (branches.local.includes(name) || !matches(`origin/${name}`)) continue;
    rows.push({ key: `origin/${name}`, name, local: false, onOrigin: true, detail: undefined });
  }
  return rows;
}

/**
 * Lists the worktree's local branches and the branches only origin has, and switches, creates,
 * renames, or deletes them. The filter box keeps focus: arrows move, Enter switches.
 */
export function BranchMenu({
  worktree,
  branches,
  onClose,
  onChanged,
}: {
  worktree: WorktreeProjection;
  branches: GitBranchesResult | undefined;
  onClose(): void;
  /** `close` is false when the menu stays open, for example after a delete. */
  onChanged(result: GitBranchesResult, notice: string, close: boolean): void;
}) {
  const { dispatch } = useRuntime();
  const listId = useId();
  const [view, setView] = useState<View>({ kind: "list" });
  const [query, setQuery] = useState("");
  const [activeKey, setActiveKey] = useState<string>();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<string>();
  const filterRef = useRef<HTMLInputElement>(null);
  const current = branches?.current;
  const rows = useMemo(() => branchRows(branches, query), [branches, query]);
  const active = rows.find((row) => row.key === activeKey) ?? rows[0];

  const run = async (action: () => Promise<GitBranchesResult>, notice: string, close: boolean) => {
    setRunning(true);
    setError(undefined);
    setStatus(undefined);
    try {
      const result = await action();
      onChanged(result, notice, close);
      if (!close) {
        setView({ kind: "list" });
        setStatus(notice);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The branch action failed.");
    } finally {
      setRunning(false);
    }
  };

  const back = () => {
    setView({ kind: "list" });
    setError(undefined);
  };

  const blocked = (row: Row | undefined) =>
    row?.detail?.worktreePath
      ? `${row.name} is checked out in another worktree at ${row.detail.worktreePath}. Switch, rename, or delete it from there.`
      : undefined;
  const canSwitch = !!active && active.key !== current && !blocked(active);
  const canRename = !!active?.local && !blocked(active);
  const canDelete = !!active && active.key !== current && !blocked(active);

  const switchTo = (row: Row) =>
    void run(() => switchBranch(dispatch, worktree.worktreeId, row.key), `Switched to ${row.name}.`, true);

  const onFilterKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (rows.length === 0) return;
      const index = active ? rows.indexOf(active) : -1;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActiveKey(rows[(index + step + rows.length) % rows.length]?.key);
    } else if (event.key === "Home" || event.key === "End") {
      if (rows.length === 0 || query) return;
      event.preventDefault();
      setActiveKey((event.key === "Home" ? rows[0] : rows.at(-1))?.key);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (active && canSwitch && !running) switchTo(active);
    }
  };

  const closeOnEscape = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || running) return;
    event.stopPropagation();
    if (view.kind === "list") onClose();
    else back();
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape from anywhere inside the dialog goes back or closes it.
    <div onKeyDown={closeOnEscape}>
      <Dialog
        label="Branches"
        className="branch-dialog"
        title={
          view.kind === "create"
            ? "New branch"
            : view.kind === "rename"
              ? "Rename branch"
              : view.kind === "delete"
                ? "Delete branch"
                : "Branches"
        }
        subtitle={
          current ? (
            <>
              This worktree is on <span className="is-mono">{current}</span>
            </>
          ) : (
            "This worktree is not on a branch."
          )
        }
        initialFocusRef={filterRef}
        onClose={() => {
          if (!running) onClose();
        }}
      >
        {view.kind === "list" ? (
          <>
            <div className="dialog-body branch-body">
              <input
                ref={filterRef}
                className="input input-sm"
                role="combobox"
                aria-label="Find a branch"
                aria-expanded="true"
                aria-autocomplete="list"
                aria-controls={listId}
                aria-activedescendant={active ? `${listId}-${active.key}` : undefined}
                placeholder="Find a branch"
                autoFocus
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActiveKey(undefined);
                }}
                onKeyDown={onFilterKeyDown}
              />
              <div className="branch-list" id={listId} role="listbox" aria-label="Branches">
                {!branches ? (
                  <p className="branch-empty">Reading the branches</p>
                ) : rows.length === 0 ? (
                  <p className="branch-empty">{query ? `No branch matches "${query}".` : "No branches yet."}</p>
                ) : (
                  rows.map((row, index) => (
                    <div key={row.key}>
                      {index === 0 || rows[index - 1]?.local !== row.local ? (
                        <p className="branch-group" aria-hidden="true">
                          {row.local ? "Local" : "Only on origin"}
                        </p>
                      ) : null}
                      <BranchRow
                        id={`${listId}-${row.key}`}
                        row={row}
                        current={row.key === current}
                        isDefault={row.name === branches.defaultBranch}
                        active={row.key === active?.key}
                        onPoint={() => setActiveKey(row.key)}
                        onPick={() => {
                          setActiveKey(row.key);
                          filterRef.current?.focus();
                        }}
                      />
                    </div>
                  ))
                )}
              </div>
              {blocked(active) ? (
                <p className="field-hint" role="status">
                  {blocked(active)}
                </p>
              ) : status ? (
                <p className="branch-status" role="status">
                  <Icon name="check" size={13} />
                  <span>{status}</span>
                </p>
              ) : null}
              <ErrorLine error={error} />
              <p className="branch-keys" aria-hidden="true">
                <kbd>↑</kbd>
                <kbd>↓</kbd> to move, <kbd>↵</kbd> to switch
              </p>
            </div>
            <div className="dialog-footer">
              <Button variant="ghost" icon="plus" disabled={running} onClick={() => setView({ kind: "create" })}>
                New branch
              </Button>
              <Button
                variant="ghost"
                icon="pencil"
                disabled={running || !canRename}
                onClick={() => active && setView({ kind: "rename", from: active.name })}
              >
                Rename
              </Button>
              <Button
                variant="ghost"
                icon="trash"
                className="is-danger"
                disabled={running || !canDelete}
                onClick={() => active && setView({ kind: "delete", row: active })}
              >
                Delete
              </Button>
              <Button
                variant="primary"
                icon="branch"
                loading={running}
                disabled={!canSwitch}
                onClick={() => active && switchTo(active)}
              >
                Switch
              </Button>
            </div>
          </>
        ) : view.kind === "create" ? (
          <CreateForm
            branches={branches}
            running={running}
            error={error}
            onCancel={back}
            onSubmit={(input) =>
              void run(
                () => createBranch(dispatch, worktree.worktreeId, input),
                input.switchTo ? `Created ${input.name} and switched to it.` : `Created ${input.name}.`,
                input.switchTo,
              )
            }
          />
        ) : view.kind === "rename" ? (
          <RenameForm
            from={view.from}
            onOrigin={!!branches?.remote.includes(view.from)}
            running={running}
            error={error}
            onCancel={back}
            onSubmit={(to) =>
              void run(
                () => renameBranch(dispatch, worktree.worktreeId, { from: view.from, to }),
                `Renamed ${view.from} to ${to}.`,
                true,
              )
            }
          />
        ) : (
          <DeleteForm
            row={view.row}
            running={running}
            error={error}
            onCancel={back}
            onSubmit={(input) =>
              void run(
                () => deleteBranch(dispatch, worktree.worktreeId, { name: view.row.name, ...input }),
                view.row.local
                  ? input.remote
                    ? `Deleted ${view.row.name} here and on origin.`
                    : `Deleted ${view.row.name}.`
                  : `Deleted ${view.row.name} on origin.`,
                false,
              )
            }
          />
        )}
      </Dialog>
    </div>
  );
}

function BranchRow({
  id,
  row,
  current,
  isDefault,
  active,
  onPoint,
  onPick,
}: {
  id: string;
  row: Row;
  current: boolean;
  isDefault: boolean;
  active: boolean;
  onPoint(): void;
  onPick(): void;
}) {
  const upstream = row.detail?.upstream;
  const track = trackText(upstream);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the filter box handles the keyboard for the list.
    <div
      id={id}
      className={`branch-row${active ? " is-active" : ""}`}
      role="option"
      aria-selected={active}
      tabIndex={-1}
      data-branch={row.key}
      onMouseDown={(event) => event.preventDefault()}
      onMouseMove={onPoint}
      onClick={onPick}
    >
      <span className="branch-row-check" aria-hidden="true">
        {current ? <Icon name="check" size={13} /> : null}
      </span>
      <span className="branch-row-name">{row.local ? row.name : `origin/${row.name}`}</span>
      {current ? <span className="sr-only">, checked out</span> : null}
      {isDefault && row.local ? <Badge tone="quiet">Default</Badge> : null}
      {row.detail?.worktreePath ? (
        <Badge tone="quiet" title={row.detail.worktreePath}>
          In another worktree
        </Badge>
      ) : null}
      {upstream?.gone ? (
        <Badge tone="quiet" title={`${upstream.name} no longer exists.`}>
          Gone on origin
        </Badge>
      ) : track ? (
        <span className="branch-track" title={trackDescription(upstream)}>
          <span aria-hidden="true">{track}</span>
          <span className="sr-only">, {trackDescription(upstream)}</span>
        </span>
      ) : null}
    </div>
  );
}

function ErrorLine({ error }: { error: string | undefined }) {
  return error ? (
    <p className="inline-error pr-error" role="alert">
      <Icon name="alert" size={13} />
      <span>{error}</span>
    </p>
  ) : null;
}

function CreateForm({
  branches,
  running,
  error,
  onCancel,
  onSubmit,
}: {
  branches: GitBranchesResult | undefined;
  running: boolean;
  error: string | undefined;
  onCancel(): void;
  onSubmit(input: { name: string; from?: string; switchTo: boolean }): void;
}) {
  const here = branches?.current;
  const [name, setName] = useState("");
  const [from, setFrom] = useState(here ?? "HEAD");
  const [switchTo, setSwitchTo] = useState(true);
  const starts = useMemo(() => {
    const options: PickerOption<string>[] = [
      here
        ? { value: here, label: here, description: "This branch" }
        : { value: "HEAD", label: "HEAD", description: "The commit checked out now" },
    ];
    for (const name of branches?.local ?? []) {
      if (name !== here) options.push({ value: name, label: name, description: "Local" });
    }
    for (const name of branches?.remote ?? []) {
      options.push({ value: `origin/${name}`, label: `origin/${name}`, description: "On origin" });
    }
    return options;
  }, [branches, here]);
  const fromHead = from === here || from === "HEAD";

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!name.trim() || running) return;
        onSubmit({ name: name.trim(), ...(fromHead ? {} : { from }), switchTo });
      }}
    >
      <div className="dialog-body">
        <Field label="Name" hint="No spaces, and none of ~ ^ : ? * [ \ or two dots in a row.">
          <input
            className="input is-mono"
            value={name}
            maxLength={255}
            spellCheck={false}
            autoComplete="off"
            // biome-ignore lint/a11y/noAutofocus: the dialog opens on this form to type the name.
            autoFocus
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label="Start from">
          <Select label="Start from" className="is-mono" value={from} options={starts} onChange={setFrom} />
        </Field>
        <Switch
          label="Switch to it"
          hint={
            fromHead
              ? "Uncommitted changes come along to the new branch."
              : "Git refuses the switch if uncommitted changes would be overwritten."
          }
          checked={switchTo}
          onChange={setSwitchTo}
        />
        <ErrorLine error={error} />
      </div>
      <div className="dialog-footer">
        <Button variant="ghost" disabled={running} onClick={onCancel}>
          Back
        </Button>
        <Button variant="primary" type="submit" icon="plus" loading={running} disabled={!name.trim()}>
          Create branch
        </Button>
      </div>
    </form>
  );
}

function RenameForm({
  from,
  onOrigin,
  running,
  error,
  onCancel,
  onSubmit,
}: {
  from: string;
  onOrigin: boolean;
  running: boolean;
  error: string | undefined;
  onCancel(): void;
  onSubmit(to: string): void;
}) {
  const [to, setTo] = useState(from);
  const changed = !!to.trim() && to.trim() !== from;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (changed && !running) onSubmit(to.trim());
      }}
    >
      <div className="dialog-body">
        <Field
          label={`New name for ${from}`}
          hint={onOrigin ? `origin/${from} keeps its old name. Push to publish the new one.` : undefined}
        >
          <input
            className="input is-mono"
            value={to}
            maxLength={255}
            spellCheck={false}
            autoComplete="off"
            // biome-ignore lint/a11y/noAutofocus: the dialog opens on this form to type the name.
            autoFocus
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setTo(event.target.value)}
          />
        </Field>
        <ErrorLine error={error} />
      </div>
      <div className="dialog-footer">
        <Button variant="ghost" disabled={running} onClick={onCancel}>
          Back
        </Button>
        <Button variant="primary" type="submit" icon="pencil" loading={running} disabled={!changed}>
          Rename branch
        </Button>
      </div>
    </form>
  );
}

function DeleteForm({
  row,
  running,
  error,
  onCancel,
  onSubmit,
}: {
  row: Row;
  running: boolean;
  error: string | undefined;
  onCancel(): void;
  onSubmit(input: { force: boolean; remote: boolean }): void;
}) {
  const [remote, setRemote] = useState(false);
  const [force, setForce] = useState(false);
  return (
    <>
      <div className="dialog-body">
        <p className="branch-confirm">
          {row.local ? (
            <>
              Delete <span className="is-mono">{row.name}</span> on this computer?
            </>
          ) : (
            <>
              Delete <span className="is-mono">{row.name}</span> on origin? It is removed for everyone who uses this
              repository.
            </>
          )}
        </p>
        {row.local && row.onOrigin ? (
          <Switch
            label="Also delete it on origin"
            hint={`Removes origin/${row.name} for everyone who uses this repository.`}
            checked={remote}
            onChange={setRemote}
          />
        ) : null}
        {row.local ? (
          <Switch
            label="Delete unmerged commits"
            hint="Git keeps a branch whose commits are not merged anywhere. Turn this on to delete it and lose those commits."
            checked={force}
            onChange={setForce}
          />
        ) : null}
        <ErrorLine error={error} />
      </div>
      <div className="dialog-footer">
        <Button variant="ghost" disabled={running} onClick={onCancel}>
          Back
        </Button>
        <Button
          variant="danger"
          icon="trash"
          autoFocus
          loading={running}
          onClick={() => onSubmit({ force: row.local && force, remote: !row.local || remote })}
        >
          Delete branch
        </Button>
      </div>
    </>
  );
}
