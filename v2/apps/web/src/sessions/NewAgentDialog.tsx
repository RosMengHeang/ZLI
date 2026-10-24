import {
  type Account,
  type ListedProviderKind,
  type PermissionMode,
  type ProjectProjection,
  type RuntimeProjection,
  worktreeHasLiveThread,
} from "@zli-v2/contracts";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { accountOptions, defaultAccountId, launchAccountId } from "../accounts/accounts.js";
import { listedDiscoveries, preferredProvider } from "../agent/providers.js";
import { ISSUE_SOURCE_NAMES, type IssueRef, issueBranchName } from "../issues/issueStart.js";
import { permissionHint, permissionIcon, permissionLabel, permissionOptions } from "../chat/permissions.js";
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
import { ModelMark, modelOptions } from "../ui/ModelMark.js";
import { Picker } from "../ui/Picker.js";
import { checkoutWorktree, type LaunchOptions, type Placement, safeBranchName } from "./launch.js";
import type { SessionMode } from "./sessions.js";
import "../issues/issues.css";

const LAST_LAUNCH_KEY = "zli.lastLaunch.v1";
const noAccounts: readonly Account[] = [];

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
  /** Sent to the agent once it is ready. */
  prompt?: string;
};

/** Starting values when the agent is started from an issue. */
export type NewAgentPrefill = { issue: IssueRef; prompt: string };

export const viewOptions: readonly ChoiceOption<SessionMode>[] = [
  { value: "terminal", label: "Terminal", icon: "terminal" },
  { value: "chat", label: "Chat", icon: "message" },
];

export const viewHint: Record<SessionMode, string> = {
  terminal: "Runs the agent's own CLI inside the tile. You can't change this later.",
  chat: "Shows messages, a work log, and changed files. You can't change this later.",
};

export function NewAgentDialog({
  projection,
  initialProject,
  initialWorktreeId,
  prefill,
  accounts = noAccounts,
  onClose,
  onSubmit,
}: {
  projection: RuntimeProjection;
  initialProject: ProjectProjection | undefined;
  initialWorktreeId: string | undefined;
  prefill?: NewAgentPrefill | undefined;
  accounts?: readonly Account[];
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
  // Unset follows the agent's default account, which can change while the dialog is open.
  const [pickedAccount, setPickedAccount] = useState<string>();
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
    !prefill && initialWorktreeId && projectWorktrees.some((worktree) => worktree.worktreeId === initialWorktreeId)
      ? "existing"
      : "new",
  );
  const branchFor = (agent: ListedProviderKind | undefined) =>
    prefill
      ? issueBranchName(settings.branchTemplate, agent, prefill.issue)
      : branchFromTemplate(settings.branchTemplate, agent);
  const [branch, setBranch] = useState(() => branchFor(provider));
  const [prompt, setPrompt] = useState(prefill?.prompt ?? "");
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
  const modelChoices = useMemo(() => modelOptions(models, model || undefined), [models, model]);
  const shownModel = modelUnsupported ? "" : model;
  const modelLabel = modelChoices.find((option) => option.value === shownModel)?.label ?? shownModel;
  const checkout = project ? checkoutWorktree(projection, project) : undefined;
  const sharedWorktreeId =
    placementKind === "checkout" ? checkout?.worktreeId : placementKind === "existing" ? existingId : undefined;
  const sharing = sharedWorktreeId !== undefined && worktreeHasLiveThread(projection.threads, sharedWorktreeId);
  const newBranch = placementKind === "new" ? safeBranchName(branch) : "";
  const accountChoices = accountOptions(accounts, provider);
  const shownAccount = provider ? (pickedAccount ?? defaultAccountId(accounts, provider)) : "";

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

  // biome-ignore lint/correctness/useExhaustiveDependencies: branchFor only reads the template and the prefill.
  useEffect(() => {
    if (!branchEdited) setBranch(branchFor(provider));
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
    const accountId = launchAccountId(accounts, provider, pickedAccount);
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
        ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
        ...(accountId ? { accountId } : {}),
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
              <Select<string>
                id={`${ids}-project`}
                label="Project"
                value={projectId ?? ""}
                options={projection.projects.map((candidate) => ({
                  value: candidate.projectId,
                  label: candidate.name,
                  icon: <Icon name="folder" size={15} />,
                }))}
                onChange={(next) => chooseProject(next as typeof projectId)}
              />
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
                    setPickedAccount(undefined);
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

          {accountChoices.length > 0 ? (
            <FormSection label="Account" htmlFor={`${ids}-account`}>
              <Select<string>
                id={`${ids}-account`}
                label="Account"
                value={shownAccount}
                options={accountChoices.map((option) => ({ ...option, icon: <Icon name="user" size={15} /> }))}
                onChange={setPickedAccount}
              />
            </FormSection>
          ) : null}

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
                <Select<string>
                  label="Worktree"
                  value={existingId ?? ""}
                  options={projectWorktrees.map((worktree) => ({
                    value: worktree.worktreeId,
                    label: worktree.branch,
                    icon: <Icon name="branch" size={15} />,
                  }))}
                  onChange={setExistingId}
                />
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
              <Picker
                variant="field"
                id={`${ids}-model`}
                label="Model"
                value={shownModel}
                options={modelChoices}
                disabled={modelUnsupported}
                onChange={setModel}
              >
                <ModelMark id={shownModel || undefined} label={modelLabel} size={15} />
                <span className="picker-trigger-label">{modelLabel}</span>
              </Picker>
            </FormSection>
            <FormSection label="Permissions" htmlFor={`${ids}-permissions`} hint={permissionHint[permissionMode]}>
              <Picker<PermissionMode>
                variant="field"
                id={`${ids}-permissions`}
                label="Permissions"
                value={permissionMode}
                options={permissionOptions}
                onChange={setPermissionMode}
              >
                <Icon name={permissionIcon[permissionMode]} size={15} />
                <span className="picker-trigger-label">{permissionLabel[permissionMode]}</span>
              </Picker>
            </FormSection>
          </div>

          {prefill ? (
            <FormSection
              label="First message"
              htmlFor={`${ids}-prompt`}
              hint="Sent to the agent as soon as it is ready. Edit it as you like."
            >
              <p className="new-agent-issue">
                <Icon name="issue" size={14} />
                <span>
                  From {ISSUE_SOURCE_NAMES[prefill.issue.source]} issue{" "}
                  <span className="issue-ref">{prefill.issue.reference}</span>
                </span>
              </p>
              <textarea
                id={`${ids}-prompt`}
                className="textarea new-agent-prompt"
                aria-label="First message"
                rows={8}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
              />
            </FormSection>
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
