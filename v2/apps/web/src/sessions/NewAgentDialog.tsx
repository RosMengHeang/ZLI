import {
  type ListedProviderKind,
  type PermissionMode,
  type ProjectProjection,
  type RuntimeProjection,
  worktreeHasLiveThread,
} from "@zli-v2/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { listedDiscoveries, preferredProvider } from "../agent/providers.js";
import { permissionLabel } from "../chat/Composer.js";
import { Icon } from "../ui/Icon.js";
import { ProviderMark } from "../ui/ProviderMark.js";
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

export type NewAgentRequest = LaunchOptions & { project: ProjectProjection; placement: Placement };

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

  useEffect(() => {
    submitRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!branchEdited) setBranch(suggestedBranch(provider));
  }, [provider, branchEdited]);

  const ready =
    project !== undefined &&
    discovery?.status === "found" &&
    (placementKind !== "new" || branch.trim().length > 0) &&
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
    });
    setBusy(false);
    if (failure) setError(failure);
  };

  return (
    <div className="palette-backdrop">
      <button className="dialog-scrim" type="button" aria-label="Close new agent dialog" onClick={onClose} />
      <section
        className="dialog new-agent-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="New agent"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-header">
          <div>
            <h2>New agent</h2>
            <p className="dialog-subtitle">Pick the agent, how you want to work with it, and where it runs.</p>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close">
            <Icon name="x" size={15} />
          </button>
        </div>
        <form
          className="dialog-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {projection.projects.length > 1 ? (
            <label className="field">
              <span className="field-label">Project</span>
              <select value={projectId} onChange={(event) => setProjectId(event.target.value as typeof projectId)}>
                {projection.projects.map((candidate) => (
                  <option key={candidate.projectId} value={candidate.projectId}>
                    {candidate.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <fieldset className="field">
            <legend className="field-label">Agent</legend>
            {projection.providers === undefined ? (
              <p className="field-hint">Checking which agent CLIs are installed.</p>
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
                className="quiet-button field-toggle"
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
                  <label className="field">
                    <span className="field-label">Branch name</span>
                    <input
                      value={branch}
                      onChange={(event) => {
                        setBranch(event.target.value);
                        setBranchEdited(true);
                      }}
                      placeholder="feature/my-change"
                    />
                  </label>
                  <label className="field">
                    <span className="field-label">Start from</span>
                    <input value={baseRef} onChange={(event) => setBaseRef(event.target.value)} placeholder="HEAD" />
                  </label>
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
                      <label className="field">
                        <span className="field-label">Worktree</span>
                        <select value={existingId} onChange={(event) => setExistingId(event.target.value)}>
                          {projectWorktrees.map((worktree) => (
                            <option key={worktree.worktreeId} value={worktree.worktreeId}>
                              {worktree.branch}
                            </option>
                          ))}
                        </select>
                      </label>
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
            <label className="field">
              <span className="field-label">Model</span>
              <select
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
              </select>
              {modelUnsupported ? <span className="field-hint">Pick the model inside the Droid CLI.</span> : null}
            </label>
            <label className="field">
              <span className="field-label">Permissions</span>
              <select
                value={permissionMode}
                onChange={(event) => setPermissionMode(event.target.value as PermissionMode)}
              >
                {(Object.keys(permissionLabel) as PermissionMode[]).map((option) => (
                  <option key={option} value={option}>
                    {permissionLabel[option]}
                  </option>
                ))}
              </select>
              <span className="field-hint">
                {permissionMode === "full-access"
                  ? "Edits files and runs commands without asking."
                  : "Asks before risky commands where the agent supports it."}
              </span>
            </label>
          </div>

          {error ? (
            <p className="inline-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="dialog-actions">
            <button className="secondary-button" type="button" onClick={onClose}>
              Cancel
            </button>
            <button className="primary-button" type="submit" ref={submitRef} disabled={!ready || busy}>
              {busy ? "Starting" : "Start agent"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
