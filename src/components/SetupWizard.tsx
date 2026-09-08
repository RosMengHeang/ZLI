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
  type AgentDraft,
  type LaunchProgress,
} from "./setup/setupModel";

const STEPS = ["Project", "Agents", "Review"];

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

  function addRow(provider: AgentProviderId) {
    setRows((current) => [
      ...current,
      {
        id: newId(),
        provider,
        role: providerDisplayName(provider),
        count: 1,
        useWorktree: provider !== "shell",
      },
    ]);
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

  function moveRow(id: string, offset: number) {
    setRows((current) => {
      const from = current.findIndex((row) => row.id === id);
      const to = from + offset;
      if (from < 0 || to < 0 || to >= current.length) return current;
      const next = [...current];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
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

  return (
    <div className="absolute inset-0 z-40 grid grid-cols-[160px_minmax(0,1fr)] bg-ink text-paper">
      <aside className="flex min-h-0 flex-col border-r border-line bg-panel p-3">
        <div className="mb-8 flex items-center gap-2 px-2 py-2 font-semibold">
          <TaxzyMark />
          Taxzy
        </div>
        <nav aria-label="Setup progress" className="space-y-2">
          {STEPS.map((label, index) => (
            <button
              key={label}
              className="nav-item"
              data-active={step === index}
              aria-current={step === index ? "step" : undefined}
              disabled={
                busy || progress !== null || (index === 0 && retained.length > 0) || (index > 0 && !project) || loading
              }
              onClick={() => setStep(index)}
            >
              <span className="text-mute">{index + 1}</span>
              {label}
            </button>
          ))}
        </nav>
        <div className="mt-auto space-y-1 pt-6">
          <button
            className="nav-item"
            disabled={busy}
            onClick={() => setHelpOpen(true)}
          >
            <IconHelp />
            Help
          </button>
          <button
            className="nav-item"
            disabled={busy}
            onClick={() => setPreferencesOpen(true)}
          >
            <IconSettings />
            Preferences
          </button>
        </div>
      </aside>
      <main className="min-w-0 overflow-y-auto p-6 lg:p-8">
        <div className="mx-auto max-w-5xl">
          <header className="mb-6 flex items-start justify-between gap-4">
            <div>
              <h1 className="text-[28px] font-semibold">
                Set up your workspace
              </h1>
              <p className="mt-1 text-mute">
                Project, tools, and a clear launch plan.
              </p>
            </div>
            <button
              className="btn btn-ghost"
              disabled={busy || loading}
              onClick={onComplete}
            >
              Skip for now
            </button>
          </header>
          <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_220px]">
            <div className="min-w-0 rounded-2xl border border-line bg-chrome p-5">
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
                    });
                  }}
                  onOpenPath={() => {
                    void openFromPath(path);
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
                  onAdd={addRow}
                  onUpdate={updateRow}
                  onRemove={(id) =>
                    setRows((current) => current.filter((row) => row.id !== id))
                  }
                  onMove={moveRow}
                  projectLocked={retained.length > 0}
                  onBack={() => { if (!retained.length) setStep(0); }}
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
            {(project || rows.length > 0) && (
              <aside
                className="min-w-0 rounded-2xl border border-line bg-chrome p-4"
                aria-label="Workspace summary"
              >
                <h2 className="font-semibold">Workspace summary</h2>
                <p className="mt-3 break-words">
                  {project?.name ?? "Choose a project"}
                </p>
                <p className="mt-1 break-all font-mono text-xs text-mute">
                  {project?.path}
                </p>
                <p className="mt-4 text-mute">
                  {retained.length + plannedAgentCount(rows)} total agents
                </p>
                <ul className="mt-2 space-y-2">
                  {rows.map((row) => (
                    <li key={row.id} className="break-words text-xs">
                      {row.count} × {row.role.trim() || row.provider}
                    </li>
                  ))}
                </ul>
              </aside>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
