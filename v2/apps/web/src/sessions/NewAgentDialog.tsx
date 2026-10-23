import {
  type ListedProviderKind,
  type PermissionMode,
  type ProjectProjection,
  type RuntimeProjection,
  worktreeHasLiveThread,
} from "@zli-v2/contracts";
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";

import { listedDiscoveries, preferredProvider } from "../agent/providers.js";
import { permissionLabel } from "../chat/Composer.js";
import { PromptList, usePromptPicker } from "../prompts/PromptPicker.js";
import { combinePrompts, usePersonalPrompts } from "../prompts/prompts.js";
import { useSharedPrompts } from "../prompts/useSharedPrompts.js";
import { Button } from "../ui/Button.js";
import { Dialog } from "../ui/Dialog.js";
import { Select } from "../ui/Field.js";
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
  // `busy` state lags a render behind, so two quick Cmd/Ctrl+Enter presses would both see it false.
  const launching = useRef(false);
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
    if (launching.current || !ready || !project || !provider) return;
    launching.current = true;
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
    let failure: string | undefined;
    try {
      failure = await onSubmit({
        project,
        placement,
        provider,
        mode,
        permissionMode,
        ...(model && !modelUnsupported ? { model } : {}),
        ...(task.trim() ? { prompt: task.trim() } : {}),
        ...(runs > 1 ? { runs: runAgents.map((agent) => agent ?? provider) } : {}),
      });
    } catch (cause) {
      failure = cause instanceof Error ? cause.message : String(cause);
    } finally {
      launching.current = false;
      setBusy(false);
    }
    if (failure) setError(failure);
  };

  const permissionHint =
    permissionMode === "full-access"
      ? "Edits files and runs commands without asking."
      : "Asks before risky commands where the agent supports it.";
  const modelHint = modelUnsupported
    ? "Pick the model inside the Droid CLI."
    : runAgents.some((agent) => agent !== provider)
      ? "Runs with another agent use its default model."
      : undefined;

  return (
    <Dialog
      label="New agent"
      size="lg"
      title="New agent"
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
        <div className="dialog-body new-agent-body">
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
                placeholder="Optional. Sent as soon as the agent starts. Type / for a saved prompt."
              />
              <PromptList
                picker={picker}
                emptyHint="No saved prompts yet. Add them from Saved prompts in the command palette."
                sharedError={sharedPrompts.error}
              />
            </div>
          </div>

          <div className="launch-rows">
            {projection.projects.length > 1 ? (
              <LaunchRow label="Project">
                <Select
                  className="input-sm"
                  aria-label="Project"
                  value={projectId}
                  onChange={(event) => setProjectId(event.target.value as typeof projectId)}
                >
                  {projection.projects.map((candidate) => (
                    <option key={candidate.projectId} value={candidate.projectId}>
                      {candidate.name}
                    </option>
                  ))}
                </Select>
              </LaunchRow>
            ) : null}

            <LaunchRow label="Agent">
              {projection.providers === undefined ? (
                <p className="loading-line">
                  <span className="spinner" aria-hidden="true" />
                  Checking which agent CLIs are installed
                </p>
              ) : listed.length === 0 ? (
                <p className="field-hint">No agent CLIs could be listed.</p>
              ) : (
                <div className="chip-group" role="radiogroup" aria-label="Agent">
                  {shownProviders.map((entry) => (
                    <label
                      className="chip-choice"
                      key={entry.provider}
                      title={
                        entry.status === "found"
                          ? entry.version
                            ? `${entry.path} (${entry.version})`
                            : entry.path
                          : `Not installed. ${entry.reason ?? ""}`.trim()
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
                      <ProviderMark provider={entry.provider} size={14} />
                      <span>{entry.displayName}</span>
                    </label>
                  ))}
                  {installed.length > 0 && missing.length > 0 ? (
                    <button
                      className="chip-more"
                      type="button"
                      aria-expanded={showMissing}
                      onClick={() => setShowMissing((value) => !value)}
                    >
                      {showMissing ? "Hide not installed" : `Show ${missing.length} not installed`}
                    </button>
                  ) : null}
                </div>
              )}
            </LaunchRow>

            <LaunchRow label="Work in">
              <div className="chip-group" role="radiogroup" aria-label="Mode">
                <label className="chip-choice" title="The agent's own CLI, full screen in a tile">
                  <input
                    type="radio"
                    name="agent-mode"
                    checked={mode === "terminal"}
                    onChange={() => setMode("terminal")}
                  />
                  <Icon name="terminal" size={13} />
                  <span>Terminal</span>
                </label>
                <label className="chip-choice" title="Messages with a work log and changed files">
                  <input type="radio" name="agent-mode" checked={mode === "chat"} onChange={() => setMode("chat")} />
                  <Icon name="message" size={13} />
                  <span>Chat</span>
                </label>
              </div>
            </LaunchRow>

            <LaunchRow label="Runs in">
              <div className="chip-group" role="radiogroup" aria-label="Where it runs">
                <label className="chip-choice" title="Its own folder and branch, so agents never collide">
                  <input
                    type="radio"
                    name="agent-placement"
                    checked={placementKind === "new"}
                    onChange={() => setPlacementKind("new")}
                  />
                  <Icon name="branch" size={13} />
                  <span>New worktree</span>
                </label>
                <label className="chip-choice" title={project?.path}>
                  <input
                    type="radio"
                    name="agent-placement"
                    checked={placementKind === "checkout"}
                    onChange={() => setPlacementKind("checkout")}
                  />
                  <Icon name="folder" size={13} />
                  <span>Current checkout</span>
                </label>
                {projectWorktrees.length > 0 ? (
                  <label className="chip-choice" title="Join a worktree that is already set up">
                    <input
                      type="radio"
                      name="agent-placement"
                      checked={placementKind === "existing"}
                      onChange={() => setPlacementKind("existing")}
                    />
                    <Icon name="folderOpen" size={13} />
                    <span>Existing worktree</span>
                  </label>
                ) : null}
              </div>
            </LaunchRow>

            {placementKind === "new" ? (
              <LaunchRow label="Branch">
                <div className="launch-inline">
                  <input
                    className="input input-sm is-mono launch-branch"
                    aria-label="Branch name"
                    value={branch}
                    onChange={(event) => {
                      setBranch(event.target.value);
                      setBranchEdited(true);
                    }}
                    placeholder="feature/my-change"
                    spellCheck={false}
                  />
                  <span className="launch-joiner">from</span>
                  <input
                    className="input input-sm is-mono launch-base"
                    aria-label="Start from"
                    value={baseRef}
                    onChange={(event) => setBaseRef(event.target.value)}
                    placeholder="HEAD"
                    spellCheck={false}
                  />
                  <span className="launch-joiner">Runs</span>
                  <Segmented<RunCount> label="Runs" value={runCount} options={runOptions} onChange={setRunCount} />
                </div>
              </LaunchRow>
            ) : placementKind === "checkout" ? (
              <LaunchRow label="Folder">
                <span className="launch-path" title={project?.path}>
                  {checkout && checkout.branch !== "HEAD" ? `${checkout.branch} in ` : ""}
                  {project?.path ?? "The project folder"}
                </span>
              </LaunchRow>
            ) : (
              <LaunchRow label="Worktree">
                <Select
                  className="input-sm"
                  aria-label="Worktree"
                  value={existingId}
                  onChange={(event) => setExistingId(event.target.value)}
                >
                  {projectWorktrees.map((worktree) => (
                    <option key={worktree.worktreeId} value={worktree.worktreeId}>
                      {worktree.branch}
                    </option>
                  ))}
                </Select>
              </LaunchRow>
            )}

            {runs > 1 ? (
              <LaunchRow
                label="Agents"
                hint="Each run gets its own worktree and the same first message. Keep the best one."
              >
                <div className="run-agents">
                  {runAgents.map((agent, index) => (
                    <Select
                      // biome-ignore lint/suspicious/noArrayIndexKey: a run is its position.
                      key={index}
                      className="input-sm"
                      aria-label={`Agent for run ${index + 1}`}
                      title={branches[index]}
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
                  ))}
                </div>
              </LaunchRow>
            ) : null}

            <LaunchRow label="Model" hint={modelHint}>
              <Select
                className="input-sm"
                aria-label="Model"
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
            </LaunchRow>

            <LaunchRow label="Permissions" hint={permissionHint}>
              <Select
                className="input-sm"
                aria-label="Permissions"
                value={permissionMode}
                onChange={(event) => setPermissionMode(event.target.value as PermissionMode)}
              >
                {(Object.keys(permissionLabel) as PermissionMode[]).map((option) => (
                  <option key={option} value={option}>
                    {permissionLabel[option]}
                  </option>
                ))}
              </Select>
            </LaunchRow>
          </div>

          {sharing ? (
            <p className="field-hint is-warning">
              Another agent is already working there. Both will edit the same files.
            </p>
          ) : null}

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

/** One labelled line of the launch form: the label sits to the left so the form stays short. */
function LaunchRow({ label, hint, children }: { label: string; hint?: string | undefined; children: ReactNode }) {
  return (
    <div className="launch-row">
      <span className="launch-label">{label}</span>
      <div className="launch-control">
        {children}
        {hint ? <span className="launch-hint">{hint}</span> : null}
      </div>
    </div>
  );
}
