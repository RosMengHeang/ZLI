import {
  type ListedProviderKind,
  type PermissionMode,
  type ProjectProjection,
  type RuntimeProjection,
  worktreeHasLiveThread,
} from "@zli-v2/contracts";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { listedDiscoveries, preferredProvider } from "../agent/providers.js";
import { permissionHint, permissionLabel, permissionModes } from "../chat/permissions.js";
import {
  branchFromTemplate,
  type LaunchDefaults,
  resolveLaunchDefaults,
  useAppSettings,
} from "../settings/appSettings.js";
import { Button } from "../ui/Button.js";
import { type ChoiceOption, ChoiceSegmented, FormSection, ProviderOptions } from "../ui/Choice.js";
import { Dialog } from "../ui/Dialog.js";
import { Select } from "../ui/Field.js";
import { Icon } from "../ui/Icon.js";
import { checkoutWorktree, type LaunchOptions, type Placement, safeBranchName } from "./launch.js";
import type { SessionMode } from "./sessions.js";

const LAST_LAUNCH_KEY = "zli.lastLaunch.v1";

function readLastLaunch(): LaunchDefaults {
  try {
    const value = JSON.parse(window.localStorage.getItem(LAST_LAUNCH_KEY) ?? "{}") as LaunchDefaults;
    if (typeof value !== "object" || value === null) return {};
    // The last launch never pins a model; that only comes from Settings.
    const { model: _model, ...rest } = value;
    return rest;
  } catch {
    return {};
  }
}

export type NewAgentRequest = LaunchOptions & {
  project: ProjectProjection;
  placement: Placement;
};

export const viewOptions: readonly ChoiceOption<SessionMode>[] = [
  { value: "terminal", label: "Terminal", icon: "terminal" },
  { value: "chat", label: "Chat", icon: "message" },
];

export const viewHint: Record<SessionMode, string> = {
  terminal: "Runs the agent's own CLI inside the tile.",
  chat: "Shows messages, a work log, and changed files.",
};

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
  const settings = useAppSettings();
  const last = useMemo(readLastLaunch, []);
  const listed = useMemo(() => listedDiscoveries(projection.providers), [projection.providers]);
  const [projectId, setProjectId] = useState(initialProject?.projectId ?? projection.projects[0]?.projectId);
  const [initial] = useState(() => launchStart(listed, resolveLaunchDefaults(settings, projectId, last)));
  const [provider, setProvider] = useState<ListedProviderKind | undefined>(initial.provider);
  const [mode, setMode] = useState<SessionMode>(initial.mode ?? "terminal");
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(initial.permissionMode ?? "full-access");
  const [model, setModel] = useState(initial.model ?? "");
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
  const [branch, setBranch] = useState(() => branchFromTemplate(settings.branchTemplate, provider));
  const [branchEdited, setBranchEdited] = useState(false);
  const [baseRef, setBaseRef] = useState("");
  const [existingId, setExistingId] = useState<string | undefined>(
    projectWorktrees.find((worktree) => worktree.worktreeId === initialWorktreeId)?.worktreeId ??
      projectWorktrees[0]?.worktreeId,
  );
  const [busy, setBusy] = useState(false);
  // `busy` state lags a render behind, so two quick Cmd/Ctrl+Enter presses would both see it false.
  const launching = useRef(false);
  const [error, setError] = useState<string>();
  const submitRef = useRef<HTMLButtonElement>(null);
  const ids = useId();
  const discovery = listed.find((entry) => entry.provider === provider);
  const models = discovery?.status === "found" ? (discovery.models ?? []) : [];
  const modelUnsupported = mode === "terminal" && provider === "droid";
  const checkout = project ? checkoutWorktree(projection, project) : undefined;
  const sharedWorktreeId =
    placementKind === "checkout" ? checkout?.worktreeId : placementKind === "existing" ? existingId : undefined;
  const sharing = sharedWorktreeId !== undefined && worktreeHasLiveThread(projection.threads, sharedWorktreeId);
  const newBranch = placementKind === "new" ? safeBranchName(branch) : "";

  const placementOptions: ChoiceOption<Placement["kind"]>[] = [
    {
      value: "new",
      label: "New worktree",
      icon: "branch",
      title: "Its own folder and branch, so agents never collide",
    },
    { value: "checkout", label: "Current checkout", icon: "folder", title: project?.path },
    ...(projectWorktrees.length > 0
      ? [{ value: "existing" as const, label: "Existing worktree", icon: "folderOpen" as const }]
      : []),
  ];

  useEffect(() => {
    if (!branchEdited) setBranch(branchFromTemplate(settings.branchTemplate, provider));
  }, [provider, branchEdited, settings.branchTemplate]);

  const chooseProject = (nextId: typeof projectId) => {
    setProjectId(nextId);
    // Moving to another project applies that project's own settings, and leaves other choices alone.
    const override = nextId ? settings.projects[nextId] : undefined;
    if (!override) return;
    const start = launchStart(listed, override);
    if (override.provider && start.provider === override.provider) {
      setProvider(start.provider);
      setModel(start.model ?? "");
    }
    if (override.mode) setMode(override.mode);
    if (override.permissionMode) setPermissionMode(override.permissionMode);
  };

  const ready =
    project !== undefined &&
    discovery?.status === "found" &&
    (placementKind !== "new" || newBranch.length > 0) &&
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
      });
    } catch (cause) {
      failure = cause instanceof Error ? cause.message : String(cause);
    } finally {
      launching.current = false;
      setBusy(false);
    }
    if (failure) setError(failure);
  };

  return (
    <Dialog
      label="New agent"
      size="lg"
      title="New agent"
      subtitle={projection.projects.length > 1 ? undefined : project?.name}
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
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void submit();
          }
        }}
      >
        <div className="dialog-body new-agent-body">
          {projection.projects.length > 1 ? (
            <FormSection label="Project" htmlFor={`${ids}-project`}>
              <Select
                id={`${ids}-project`}
                aria-label="Project"
                value={projectId}
                onChange={(event) => chooseProject(event.target.value as typeof projectId)}
              >
                {projection.projects.map((candidate) => (
                  <option key={candidate.projectId} value={candidate.projectId}>
                    {candidate.name}
                  </option>
                ))}
              </Select>
            </FormSection>
          ) : null}

          <FormSection label="Agent">
            {projection.providers === undefined ? (
              <p className="loading-line">
                <span className="spinner" aria-hidden="true" />
                Looking for installed agent CLIs
              </p>
            ) : listed.length === 0 ? (
              <p className="form-section-hint">No agent CLIs were found on this computer.</p>
            ) : (
              <>
                <ProviderOptions
                  name="agent-provider"
                  entries={shownProviders}
                  value={provider}
                  onChange={(next) => {
                    setProvider(next as ListedProviderKind);
                    setModel("");
                  }}
                />
                {installed.length > 0 && missing.length > 0 ? (
                  <button
                    className="form-link"
                    type="button"
                    aria-expanded={showMissing}
                    onClick={() => setShowMissing((value) => !value)}
                  >
                    {showMissing ? "Hide not installed" : `Show ${missing.length} not installed`}
                  </button>
                ) : null}
              </>
            )}
          </FormSection>

          <FormSection label="View" hint={viewHint[mode]}>
            <ChoiceSegmented<SessionMode>
              name="agent-mode"
              label="View"
              value={mode}
              options={viewOptions}
              onChange={setMode}
            />
          </FormSection>

          <FormSection label="Workspace">
            <ChoiceSegmented<typeof placementKind>
              name="agent-placement"
              label="Workspace"
              value={placementKind}
              options={placementOptions}
              onChange={setPlacementKind}
            />
            <div className="workspace-detail">
              {placementKind === "new" ? (
                <div className="form-grid">
                  <FormSection label="Branch name" htmlFor={`${ids}-branch`}>
                    <input
                      id={`${ids}-branch`}
                      className="input is-mono"
                      aria-label="Branch name"
                      value={branch}
                      onChange={(event) => {
                        setBranch(event.target.value);
                        setBranchEdited(true);
                      }}
                      placeholder="feature/my-change"
                      spellCheck={false}
                    />
                  </FormSection>
                  <FormSection label="Start from" htmlFor={`${ids}-base`}>
                    <input
                      id={`${ids}-base`}
                      className="input is-mono"
                      aria-label="Start from"
                      value={baseRef}
                      onChange={(event) => setBaseRef(event.target.value)}
                      placeholder="HEAD"
                      spellCheck={false}
                    />
                  </FormSection>
                </div>
              ) : placementKind === "checkout" ? (
                <p className="workspace-path" title={project?.path}>
                  <Icon name="folder" size={14} />
                  <span>{project?.path ?? "The project folder"}</span>
                  {checkout && checkout.branch !== "HEAD" ? (
                    <span className="workspace-branch">{checkout.branch}</span>
                  ) : null}
                </p>
              ) : (
                <Select
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
              )}
            </div>
            {sharing ? (
              <p className="form-section-hint is-warning">
                Another agent is already working here, so both will edit the same files.
              </p>
            ) : null}
          </FormSection>

          <div className="form-grid">
            <FormSection
              label="Model"
              htmlFor={`${ids}-model`}
              hint={modelUnsupported ? "Droid picks its model inside the CLI." : undefined}
            >
              <Select
                id={`${ids}-model`}
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
            </FormSection>
            <FormSection label="Permissions" htmlFor={`${ids}-permissions`} hint={permissionHint[permissionMode]}>
              <Select
                id={`${ids}-permissions`}
                aria-label="Permissions"
                value={permissionMode}
                onChange={(event) => setPermissionMode(event.target.value as PermissionMode)}
              >
                {permissionModes.map((option) => (
                  <option key={option} value={option}>
                    {permissionLabel[option]}
                  </option>
                ))}
              </Select>
            </FormSection>
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
            {newBranch ? (
              <>
                Creates branch <code>{newBranch}</code>
              </>
            ) : null}
          </span>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" ref={submitRef} disabled={!ready} loading={busy} shortcut="Mod+Enter">
            {busy ? "Starting" : "Start agent"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * Turns the resolved defaults into the dialog's starting state: a default agent that is not installed falls
 * back to the preferred one, and a default model is kept only if that agent still offers it.
 */
function launchStart(listed: ReturnType<typeof listedDiscoveries>, defaults: LaunchDefaults): LaunchDefaults {
  const found = listed.find((entry) => entry.provider === defaults.provider && entry.status === "found");
  const provider = found?.provider ?? preferredProvider(listed);
  const models = found?.status === "found" ? (found.models ?? []) : [];
  const model =
    found && defaults.model && models.some((option) => option.id === defaults.model) ? defaults.model : undefined;
  return {
    ...(provider ? { provider } : {}),
    ...(defaults.mode ? { mode: defaults.mode } : {}),
    ...(defaults.permissionMode ? { permissionMode: defaults.permissionMode } : {}),
    ...(model ? { model } : {}),
  };
}
