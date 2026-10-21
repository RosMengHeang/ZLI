import {
  type ListedProviderKind,
  type PermissionMode,
  type ProjectProjection,
  type RuntimeProjection,
  worktreeHasLiveThread,
} from "@zli-v2/contracts";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { listedDiscoveries, preferredProvider } from "../agent/providers.js";
import { permissionLabel } from "../chat/Composer.js";
import { PromptList, usePromptPicker } from "../prompts/PromptPicker.js";
import { combinePrompts, usePersonalPrompts } from "../prompts/prompts.js";
import { useSharedPrompts } from "../prompts/useSharedPrompts.js";
import { Button } from "../ui/Button.js";
import { Dialog } from "../ui/Dialog.js";
import { Field, Select } from "../ui/Field.js";
import { Icon } from "../ui/Icon.js";
import { ProviderMark } from "../ui/ProviderMark.js";
import { Segmented, type SegmentedOption } from "../ui/Segmented.js";
import { MAX_RUNS, runBranches } from "./bestOf.js";
import { checkoutWorktree, type LaunchOptions, type Placement } from "./launch.js";
import type { SessionMode } from "./sessions.js";

const LAST_LAUNCH_KEY = "zli.lastLaunch.v1";

type LastLaunch = { provider?: ListedProviderKind; mode?: SessionMode; permissionMode?: PermissionMode };

function readLastLaunch(): LastLaunch {
  try {
    const value = JSON.parse(window.localStorage.getItem(LAST_LAUNCH_KEY) ?? "{}") as LastLaunch;
    return typeof value === "object" && value !== null ? value : {};
  } catch {
    return {};
  }
}

const branchStems: Partial<Record<ListedProviderKind, string>> = {
  "claude-code": "claude",
  "cursor-agent": "cursor",
};

function suggestedBranch(provider: ListedProviderKind | undefined): string {
  const stem = provider ? (branchStems[provider] ?? provider) : "agent";
  return `${stem}-${Math.random().toString(36).slice(2, 6)}`;
}

export type NewAgentRequest = LaunchOptions & {
  project: ProjectProjection;
  placement: Placement;
  /** The first message, sent once the agent is running. */
  prompt?: string;
  /** Agents for a best-of run, one per new worktree. Absent for a single agent. */
  runs?: ListedProviderKind[];
};

type RunCount = "1" | "2" | "3" | "4";

const runOptions: readonly SegmentedOption<RunCount>[] = Array.from({ length: MAX_RUNS }, (_, index) => {
  const value = String(index + 1) as RunCount;
  return { value, label: value, ariaLabel: index === 0 ? "1 run" : `${value} runs` };
});

export function NewAgentDialog({
  projection,
  initialProject,
  initialWorktreeId,
  onClose,
  onSubmit,
}: {
  projection: RuntimeProjection;
  initialProject: ProjectProjection | undefined;
  initialWorktreeId: string | undefined;
  onClose(): void;
  onSubmit(request: NewAgentRequest): Promise<string | undefined>;
}) {
  const last = useMemo(readLastLaunch, []);
  const listed = useMemo(() => listedDiscoveries(projection.providers), [projection.providers]);
  const [projectId, setProjectId] = useState(initialProject?.projectId ?? projection.projects[0]?.projectId);
  const [provider, setProvider] = useState<ListedProviderKind | undefined>(() => {
    const remembered = listed.find((entry) => entry.provider === last.provider && entry.status === "found");
    return remembered?.provider ?? preferredProvider(listed);
  });
  const [mode, setMode] = useState<SessionMode>(last.mode ?? "terminal");
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(last.permissionMode ?? "full-access");
  const [model, setModel] = useState("");
  const [showMissing, setShowMissing] = useState(false);
  const installed = listed.filter((entry) => entry.status === "found");
  const missing = listed.filter((entry) => entry.status !== "found");
  const shownProviders = installed.length === 0 || showMissing ? [...installed, ...missing] : installed;
  const project = projection.projects.find((candidate) => candidate.projectId === projectId);
  const projectWorktrees = projection.worktrees.filter(
    (worktree) =>
      worktree.projectId === projectId &&
      worktree.kind !== "checkout" &&
      (worktree.status === "ready" ||
        worktree.status === "queued" ||
        worktree.status === "creating" ||
        worktree.status === "fetching" ||
        worktree.status === "bootstrapping"),
  );
  const [placementKind, setPlacementKind] = useState<Placement["kind"]>(() =>
    initialWorktreeId && projectWorktrees.some((worktree) => worktree.worktreeId === initialWorktreeId)
      ? "existing"
      : "new",
  );
  const [branch, setBranch] = useState(() => suggestedBranch(provider));
  const [branchEdited, setBranchEdited] = useState(false);
  const [baseRef, setBaseRef] = useState("");
  const [existingId, setExistingId] = useState<string | undefined>(
    projectWorktrees.find((worktree) => worktree.worktreeId === initialWorktreeId)?.worktreeId ??
      projectWorktrees[0]?.worktreeId,
  );
  const [runCount, setRunCount] = useState<RunCount>("1");
  const [runProviders, setRunProviders] = useState<Partial<Record<number, ListedProviderKind>>>({});
  const [task, setTask] = useState("");
  const taskId = useId();
  const personalPrompts = usePersonalPrompts();
  const sharedPrompts = useSharedPrompts(projectId);
  const prompts = useMemo(
    () => combinePrompts(sharedPrompts.prompts, personalPrompts),
    [sharedPrompts.prompts, personalPrompts],
  );
  const picker = usePromptPicker({ draft: task, setDraft: setTask, prompts });
  const taskRef = useRef<HTMLTextAreaElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submitRef = useRef<HTMLButtonElement>(null);
  const discovery = listed.find((entry) => entry.provider === provider);
  const models = discovery?.status === "found" ? (discovery.models ?? []) : [];
  const modelUnsupported = mode === "terminal" && provider === "droid";
  const checkout = project ? checkoutWorktree(projection, project) : undefined;
  const sharedWorktreeId =
    placementKind === "checkout" ? checkout?.worktreeId : placementKind === "existing" ? existingId : undefined;
  const sharing = sharedWorktreeId !== undefined && worktreeHasLiveThread(projection.threads, sharedWorktreeId);
  const runs = placementKind === "new" ? Number(runCount) : 1;
  const branches = runBranches(branch, runs);
  const runAgents = Array.from({ length: runs }, (_, index) => runProviders[index] ?? provider);

  useEffect(() => {
    if (!branchEdited) setBranch(suggestedBranch(provider));
  }, [provider, branchEdited]);

  const ready =
    project !== undefined &&
    discovery?.status === "found" &&
    (placementKind !== "new" || branches.length > 0) &&
    (placementKind !== "existing" || existingId !== undefined);

  const submit = async () => {
    if (!ready || !project || !provider) return;
    const placement: Placement =
      placementKind === "new"
        ? { kind: "new", branch, baseRef }
        : placementKind === "checkout"
          ? { kind: "checkout" }
          : { kind: "existing", worktreeId: existingId ?? "" };
    setBusy(true);
    setError(undefined);
    try {
      window.localStorage.setItem(LAST_LAUNCH_KEY, JSON.stringify({ provider, mode, permissionMode }));
    } catch {
      // Remembering the last choice is a convenience only.
    }
    const failure = await onSubmit({
      project,
      placement,
      provider,
      mode,
      permissionMode,
      ...(model && !modelUnsupported ? { model } : {}),
      ...(task.trim() ? { prompt: task.trim() } : {}),
      ...(runs > 1 ? { runs: runAgents.map((agent) => agent ?? provider) } : {}),
    });
    setBusy(false);
    if (failure) setError(failure);
  };

  return (
    <Dialog
      label="New agent"
      size="lg"
      title="New agent"
      subtitle="Pick the agent, how you want to work with it, and where it runs."
      className="new-agent-dialog"
      scrimLabel="Close new agent dialog"
      initialFocusRef={submitRef}
      onClose={onClose}
    >
      <form
        className="dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="dialog-body">
          {projection.projects.length > 1 ? (
            <Field label="Project">
              <Select value={projectId} onChange={(event) => setProjectId(event.target.value as typeof projectId)}>
                {projection.projects.map((candidate) => (
                  <option key={candidate.projectId} value={candidate.projectId}>
                    {candidate.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}

          <fieldset className="field">
            <legend className="field-label">Agent</legend>
            {projection.providers === undefined ? (
              <p className="loading-line">
                <span className="spinner" aria-hidden="true" />
                Checking which agent CLIs are installed
              </p>
            ) : listed.length === 0 ? (
              <p className="field-hint">No agent CLIs could be listed.</p>
            ) : (
              <div className="choice-grid" role="radiogroup" aria-label="Agent">
                {shownProviders.map((entry) => (
                  <label
                    className={`choice-card is-compact${entry.status === "missing" ? " is-missing" : ""}`}
                    key={entry.provider}
                    title={
                      entry.status === "found"
                        ? entry.version
                          ? `${entry.path} (${entry.version})`
                          : entry.path
                        : entry.reason
                    }
                  >
                    <input
                      type="radio"
                      name="agent-provider"
                      value={entry.provider}
                      checked={provider === entry.provider}
                      disabled={entry.status === "missing"}
                      onChange={() => {
                        setProvider(entry.provider);
                        setModel("");
                      }}
                    />
                    <ProviderMark provider={entry.provider} size={16} />
                    <span className="choice-copy">
                      <span className="choice-title">{entry.displayName}</span>
                      <span className="choice-detail">{entry.status === "found" ? "Installed" : "Not found"}</span>
                    </span>
                  </label>
                ))}
              </div>
            )}
            {installed.length > 0 && missing.length > 0 ? (
              <button
                className="btn btn-ghost btn-xs field-toggle"
                type="button"
                aria-expanded={showMissing}
                onClick={() => setShowMissing((value) => !value)}
              >
                <Icon name="chevronRight" size={11} className={showMissing ? "is-open" : undefined} />
                {showMissing ? "Hide agents that are not installed" : `Show ${missing.length} not installed`}
              </button>
            ) : null}
          </fieldset>

          <fieldset className="field">
            <legend className="field-label">Work in</legend>
            <div className="choice-grid is-two" role="radiogroup" aria-label="Mode">
              <label className="choice-card">
                <input
                  type="radio"
                  name="agent-mode"
                  checked={mode === "terminal"}
                  onChange={() => setMode("terminal")}
                />
                <Icon name="terminal" size={15} />
                <span className="choice-copy">
                  <span className="choice-title">Terminal</span>
                  <span className="choice-detail">The agent's own CLI, full screen in a tile</span>
                </span>
              </label>
              <label className="choice-card">
                <input type="radio" name="agent-mode" checked={mode === "chat"} onChange={() => setMode("chat")} />
                <Icon name="message" size={15} />
                <span className="choice-copy">
                  <span className="choice-title">Chat</span>
                  <span className="choice-detail">Messages with a work log and changed files</span>
                </span>
              </label>
            </div>
          </fieldset>

          <div className="field">
            <div className="prompt-label-row">
              <label className="field-label" htmlFor={taskId}>
                First message
              </label>
              <Button
                variant="ghost"
                size="xs"
                icon="bookmark"
                aria-pressed={picker.open}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  picker.toggle();
                  taskRef.current?.focus();
                }}
              >
                Saved prompts
              </Button>
            </div>
            <div className="prompt-anchor is-inline">
              <textarea
                id={taskId}
                ref={taskRef}
                className="textarea"
                rows={3}
                value={task}
                onChange={(event) => setTask(event.target.value)}
                {...picker.inputProps}
                onKeyDown={(event) => {
                  if (picker.onKeyDown(event)) return;
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    void submit();
                  }
                }}
                placeholder="Optional. Type / to insert a saved prompt."
              />
              <PromptList
                picker={picker}
                emptyHint="No saved prompts yet. Add them from Saved prompts in the command palette."
                sharedError={sharedPrompts.error}
              />
            </div>
            <span className="field-hint">Sent to the agent as soon as it starts.</span>
          </div>

          <fieldset className="field">
            <legend className="field-label">Where it runs</legend>
            <div className="placement-list" role="radiogroup" aria-label="Where it runs">
              <label className="choice-card">
                <input
                  type="radio"
                  name="agent-placement"
                  checked={placementKind === "new"}
                  onChange={() => setPlacementKind("new")}
                />
                <Icon name="branch" size={15} />
                <span className="choice-copy">
                  <span className="choice-title">New worktree</span>
                  <span className="choice-detail">Its own folder and branch, so agents never collide</span>
                </span>
              </label>
              {placementKind === "new" ? (
                <div className="placement-fields">
                  <Field label="Branch name">
                    <input
                      className="input is-mono"
                      value={branch}
                      onChange={(event) => {
                        setBranch(event.target.value);
                        setBranchEdited(true);
                      }}
                      placeholder="feature/my-change"
                      spellCheck={false}
                    />
                  </Field>
                  <Field label="Start from">
                    <input
                      className="input is-mono"
                      value={baseRef}
                      onChange={(event) => setBaseRef(event.target.value)}
                      placeholder="HEAD"
                      spellCheck={false}
                    />
                  </Field>
                  <div className="field run-count">
                    <span className="field-label">Runs</span>
                    <Segmented<RunCount> label="Runs" value={runCount} options={runOptions} onChange={setRunCount} />
                    <span className="field-hint">
                      {runs > 1
                        ? "Each run gets its own worktree and the same first message. Keep the best one."
                        : "Start up to four agents on the same task to compare."}
                    </span>
                  </div>
                  {runs > 1 ? (
                    <div className="run-agents">
                      {runAgents.map((agent, index) => (
                        <Field
                          // biome-ignore lint/suspicious/noArrayIndexKey: a run is its position.
                          key={index}
                          label={`Run ${index + 1}`}
                          hint={branches[index]}
                        >
                          <Select
                            aria-label={`Agent for run ${index + 1}`}
                            value={agent}
                            onChange={(event) =>
                              setRunProviders((current) => ({
                                ...current,
                                [index]: event.target.value as ListedProviderKind,
                              }))
                            }
                          >
                            {installed.map((entry) => (
                              <option key={entry.provider} value={entry.provider}>
                                {entry.displayName}
                              </option>
                            ))}
                          </Select>
                        </Field>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
              <label className="choice-card">
                <input
                  type="radio"
                  name="agent-placement"
                  checked={placementKind === "checkout"}
                  onChange={() => setPlacementKind("checkout")}
                />
                <Icon name="folder" size={15} />
                <span className="choice-copy">
                  <span className="choice-title">Current checkout</span>
                  <span className="choice-detail" title={project?.path}>
                    {checkout && checkout.branch !== "HEAD" ? `${checkout.branch} in ` : ""}
                    {project?.path ?? "The project folder"}
                  </span>
                </span>
              </label>
              {projectWorktrees.length > 0 ? (
                <>
                  <label className="choice-card">
                    <input
                      type="radio"
                      name="agent-placement"
                      checked={placementKind === "existing"}
                      onChange={() => setPlacementKind("existing")}
                    />
                    <Icon name="folderOpen" size={15} />
                    <span className="choice-copy">
                      <span className="choice-title">Existing worktree</span>
                      <span className="choice-detail">Join a worktree that is already set up</span>
                    </span>
                  </label>
                  {placementKind === "existing" ? (
                    <div className="placement-fields">
                      <Field label="Worktree">
                        <Select value={existingId} onChange={(event) => setExistingId(event.target.value)}>
                          {projectWorktrees.map((worktree) => (
                            <option key={worktree.worktreeId} value={worktree.worktreeId}>
                              {worktree.branch}
                            </option>
                          ))}
                        </Select>
                      </Field>
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
            {sharing ? (
              <p className="field-hint is-warning">
                Another agent is already working there. Both will edit the same files.
              </p>
            ) : null}
          </fieldset>

          <div className="field-row">
            <Field
              label="Model"
              hint={
                modelUnsupported
                  ? "Pick the model inside the Droid CLI."
                  : runAgents.some((agent) => agent !== provider)
                    ? "Runs with another agent use its default model."
                    : undefined
              }
            >
              <Select
                value={modelUnsupported ? "" : model}
                disabled={modelUnsupported}
                onChange={(event) => setModel(event.target.value)}
              >
                <option value="">Default model</option>
                {models.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Permissions"
              hint={
                permissionMode === "full-access"
                  ? "Edits files and runs commands without asking."
                  : "Asks before risky commands where the agent supports it."
              }
            >
              <Select
                value={permissionMode}
                onChange={(event) => setPermissionMode(event.target.value as PermissionMode)}
              >
                {(Object.keys(permissionLabel) as PermissionMode[]).map((option) => (
                  <option key={option} value={option}>
                    {permissionLabel[option]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          {error ? (
            <p className="inline-error" role="alert">
              <Icon name="alert" size={13} />
              {error}
            </p>
          ) : null}
        </div>
        <div className="dialog-footer">
          <span className="dialog-footer-note">
            {placementKind !== "new" || branches.length === 0
              ? null
              : branches.length === 1
                ? `Creates branch ${branches[0]}`
                : `Creates branches ${branches[0]} to ${branches.at(-1)}`}
          </span>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" ref={submitRef} disabled={!ready} loading={busy}>
            {busy ? "Starting" : runs > 1 ? `Start ${runs} agents` : "Start agent"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
