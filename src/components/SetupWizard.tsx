import { useEffect, useRef, useState } from "react";
import { IconHelp, IconSettings, TaxzyMark } from "./AppIcons";
import { useAgentStore } from "../stores/agentStore";
import { useProjectStore } from "../stores/projectStore";
import { useUiStore } from "../stores/uiStore";
import { providerDisplayName, type AgentProviderId } from "../types";
import { getLastProjectPath } from "../lib/preferences";
import { newId } from "../lib/ids";
import { SetupProjectStep } from "./setup/SetupProjectStep";
import { SetupAgentsStep } from "./setup/SetupAgentsStep";
import { SetupReviewStep } from "./setup/SetupReviewStep";
import {
  clampAgentCount,
  expandLaunchPlan,
  pendingLaunchIndexes,
  plannedAgentCount,
  setProviderQuantity as updateProviderQuantity,
  type AgentDraft,
  type LaunchProgress,
} from "./setup/setupModel";

const STEPS = ["Workspace", "Agents", "Launch"];

export function SetupWizard({ onComplete }: { onComplete: () => void }) {
  const project = useProjectStore((state) => state.project);
  const loading = useProjectStore((state) => state.loading);
  const projectError = useProjectStore((state) => state.error);
  const openFromDialog = useProjectStore((state) => state.openFromDialog);
  const openFromPath = useProjectStore((state) => state.openFromPath);
  const providers = useAgentStore((state) => state.providers);
  const providersLoaded = useAgentStore((state) => state.providersLoaded);
  const providersError = useAgentStore((state) => state.providersError);
  const loadProviders = useAgentStore((state) => state.loadProviders);
  const launch = useAgentStore((state) => state.launch);
  const setHelpOpen = useUiStore((state) => state.setHelpOpen);
  const setPreferencesOpen = useUiStore((state) => state.setPreferencesOpen);
  const setBrowserOpen = useUiStore((state) => state.setBrowserOpen);
  const [step, setStep] = useState(project ? 1 : 0);
  const [path, setPath] = useState(getLastProjectPath() ?? "");
  const [manual, setManual] = useState(false);
  const [rows, setRows] = useState<AgentDraft[]>([]);
  const [progress, setProgress] = useState<LaunchProgress[] | null>(null);
  const [retained, setRetained] = useState<LaunchProgress[]>([]);
  const [busy, setBusy] = useState(false);
  const launchLock = useRef(false);
  const failedAttempts = useRef(new Set<string>());
  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  const plan: LaunchProgress[] =
    progress ??
    [...retained, ...expandLaunchPlan(rows).map((item): LaunchProgress => ({ ...item, status: "waiting" }))];
  const unavailable = [
    ...new Set(
      plan
        .filter(
          (item) =>
            item.status !== "running" &&
            item.provider !== "shell" &&
            !providers.find((provider) => provider.id === item.provider)
              ?.installed,
        )
        .map((item) => providerDisplayName(item.provider)),
    ),
  ];

  function finish() {
    if (launchLock.current) return;
    setBrowserOpen(true);
    onComplete();
  }

  function setProviderQuantity(provider: AgentProviderId, quantity: number) {
    setRows((current) => updateProviderQuantity(current, provider, quantity));
  }

  function editFailed() {
    if (busy || !progress) { setStep(1); return; }
    setRetained(progress.filter((item) => item.status === "running"));
    setRows(progress.filter((item) => item.status !== "running").map((item) => ({
      id: newId(), provider: item.provider, role: item.name, count: 1, useWorktree: item.useWorktree,
    })));
    setProgress(null);
    setStep(1);
  }

  function updateRow(id: string, patch: Partial<AgentDraft>) {
    setRows((current) =>
      current.map((row) =>
        row.id === id
          ? {
              ...row,
              ...patch,
              count: clampAgentCount(patch.count ?? row.count),
            }
          : row,
      ),
    );
  }

  async function start() {
    if (
      launchLock.current ||
      !project ||
      !providersLoaded ||
      unavailable.length
    )
      return;
    if (!plan.length) {
      finish();
      return;
    }
    launchLock.current = true;
    setBusy(true);
    const next = plan.map((item) => ({ ...item }));
    const indexes = pendingLaunchIndexes(next, progress !== null);
    for (const index of indexes)
      next[index] = { ...next[index], status: "waiting", error: undefined };
    setProgress([...next]);
    try {
      for (const index of indexes) {
        next[index] = { ...next[index], status: "starting" };
        setProgress([...next]);
        try {
          const item = next[index];
          for (const id of failedAttempts.current) {
            await useAgentStore.getState().retireFailed(id);
            failedAttempts.current.delete(id);
          }
          const agent = await launch({
            name: item.name,
            provider: item.provider,
            createWorktree: item.useWorktree,
          });
          const success =
            agent &&
            (agent.status === "running" || agent.status === "starting");
          if (agent && !success) {
            failedAttempts.current.add(agent.id);
            await useAgentStore.getState().retireFailed(agent.id);
            failedAttempts.current.delete(agent.id);
          }
          next[index] = {
            ...item,
            status: success ? "running" : "failed",
            error: success
              ? undefined
              : agent?.error ||
                useAgentStore.getState().launchError?.message ||
                "Agent could not start. Check the CLI and try again.",
          };
        } catch (error) {
          next[index] = {
            ...next[index],
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          };
        }
        setProgress([...next]);
      }
    } finally {
      launchLock.current = false;
      setBusy(false);
    }
    if (next.every((item) => item.status === "running")) finish();
  }

  const heading = !project
    ? "Choose a workspace"
    : step === 1
      ? "Configure your agents"
      : "Review your launch";
  const subheading = !project
    ? "Open a local Git repository to get started."
    : step === 1
      ? "Pick the tools you want to run side by side."
      : "Everything is ready for a focused workspace.";

  return (
    <div className="setup-screen absolute inset-0 z-40 overflow-y-auto text-paper">
      <div className="setup-container">
        <header className="setup-topbar">
          <div className="flex items-center gap-2.5">
            <TaxzyMark className="h-7 w-7" />
            <div>
              <p className="text-[14px] font-semibold tracking-tight">Taxzy</p>
              <p className="text-[10px] text-mute">Agent workspace</p>
            </div>
          </div>

          <nav className="setup-progress" aria-label="Setup progress">
            {STEPS.map((label, index) => {
              const complete = Boolean(index < step || (index === 0 && project));
              const active = step === index;
              return (
                <button
                  key={label}
                  type="button"
                  className="setup-progress-item"
                  data-active={active}
                  data-complete={complete}
                  aria-current={active ? "step" : undefined}
                  disabled={
                    busy ||
                    progress !== null ||
                    (index === 0 && retained.length > 0) ||
                    (index > 0 && !project) ||
                    loading
                  }
                  onClick={() => setStep(index)}
                >
                  <span className="setup-progress-number">{complete ? "✓" : index + 1}</span>
                  <span>{label}</span>
                </button>
              );
            })}
          </nav>

          <div className="flex items-center gap-1">
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              disabled={busy}
              onClick={() => setHelpOpen(true)}
              aria-label="Help"
              title="Help"
            >
              <IconHelp />
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              disabled={busy}
              onClick={() => setPreferencesOpen(true)}
              aria-label="Preferences"
              title="Preferences"
            >
              <IconSettings />
            </button>
            <button
              type="button"
              className="btn btn-ghost ml-1"
              disabled={busy || loading}
              onClick={onComplete}
            >
              Skip for now
            </button>
          </div>
        </header>

        <main className="setup-main">
          <div className="setup-heading-block">
            <p className="setup-eyebrow">{project ? "Workspace setup" : "Welcome to Taxzy"}</p>
            <h1 className="setup-page-title">{heading}</h1>
            <p className="setup-page-subtitle">{subheading}</p>
          </div>

          <div className="setup-content-grid">
            <div className="setup-main-card">
              {step === 0 && (
                <SetupProjectStep
                  project={project}
                  loading={loading}
                  error={projectError?.message}
                  path={path}
                  manual={manual}
                  onPath={setPath}
                  onManual={() => setManual(true)}
                  onChoose={() => {
                    void openFromDialog().then((result) => {
                      if (result === "failed") setManual(true);
                      if (result === "opened") setStep(1);
                    });
                  }}
                  onOpenPath={() => {
                    void openFromPath(path).then((opened) => {
                      if (opened) setStep(1);
                    });
                  }}
                  onContinue={() => setStep(1)}
                />
              )}
              {step === 1 && (
                <SetupAgentsStep
                  rows={rows}
                  providers={providers}
                  scanning={!providersLoaded}
                  error={providersError?.message}
                  onRescan={() => {
                    void loadProviders(true);
                  }}
                  onSetQuantity={setProviderQuantity}
                  onUpdate={updateRow}
                  projectLocked={retained.length > 0}
                  onBack={() => {
                    if (!retained.length) setStep(0);
                  }}
                  onContinue={() => setStep(2)}
                />
              )}
              {step === 2 && (
                <SetupReviewStep
                  project={project}
                  items={plan}
                  busy={busy}
                  attempted={progress !== null}
                  scanning={!providersLoaded}
                  unavailable={unavailable}
                  detectionError={providersError?.message}
                  onRescan={() => {
                    void loadProviders(true);
                  }}
                  onBack={editFailed}
                  onStart={start}
                  onFinish={finish}
                />
              )}
            </div>

            <aside className="setup-side-card" aria-label="Setup summary">
              {!project ? (
                <>
                  <p className="setup-eyebrow">A clear starting point</p>
                  <h2 className="mt-2 text-[16px] font-semibold leading-6">
                    One project. Every agent in view.
                  </h2>
                  <p className="mt-3 text-[12px] leading-5 text-mute">
                    Choose a repository first. Then Taxzy will detect the tools
                    installed on your computer and let you decide how much
                    parallel help you need.
                  </p>
                  <ol className="setup-benefit-list">
                    <li><span>01</span> Open a local Git folder</li>
                    <li><span>02</span> Choose providers and quantities</li>
                    <li><span>03</span> Launch a calm, focused grid</li>
                  </ol>
                </>
              ) : (
                <>
                  <p className="setup-eyebrow">Current workspace</p>
                  <h2 className="mt-2 truncate text-[16px] font-semibold">
                    {project.name}
                  </h2>
                  <p className="mt-2 break-all font-mono text-[11px] leading-5 text-mute">
                    {project.path}
                  </p>
                  <div className="setup-side-stat">
                    <span>Selected agents</span>
                    <strong>{retained.length + plannedAgentCount(rows)}</strong>
                  </div>
                  <div className="mt-4 flex items-center gap-2 text-[11px]">
                    <span className={project.clean ? "status-dot" : "status-dot"} data-tone={project.clean ? "success" : "warning"} />
                    <span className={project.clean ? "text-ok" : "text-warn"}>
                      {project.clean ? "Clean working tree" : "Uncommitted changes"}
                    </span>
                  </div>
                  <ul className="mt-4 space-y-2 border-t border-line pt-4">
                    {rows.length ? rows.map((row) => (
                      <li key={row.id} className="flex items-center justify-between gap-3 text-[11px]">
                        <span className="truncate text-mute">{providerDisplayName(row.provider)}</span>
                        <span className="font-medium text-paper">× {row.count}</span>
                      </li>
                    )) : (
                      <li className="text-[11px] text-mute">Choose a provider to see your mix.</li>
                    )}
                  </ul>
                </>
              )}
            </aside>
          </div>
        </main>
      </div>
    </div>
  );
}
