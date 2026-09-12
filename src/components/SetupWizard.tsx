import { useEffect, useRef, useState } from "react";
import { IconHelp, IconSettings, ZliMark } from "./AppIcons";
import { useAgentStore } from "../stores/agentStore";
import { useTerminalStore } from "../stores/terminalStore";
import { useProjectStore } from "../stores/projectStore";
import { useUiStore } from "../stores/uiStore";
import { providerDisplayName, type AgentProviderId } from "../types";
import { getLastProjectPath } from "../lib/preferences";
import { newId } from "../lib/ids";
import { providerLaunchFailureMessage } from "../lib/providerDiagnostics";
import { SetupProjectStep } from "./setup/SetupProjectStep";
import { SetupAgentsStep } from "./setup/SetupAgentsStep";
import { SetupReviewStep } from "./setup/SetupReviewStep";
import { Button } from "@/components/ui/button";
import {
  clampAgentCount,
  canEnterWorkspace,
  expandLaunchPlan,
  pendingLaunchIndexes,
  setProviderQuantity as updateProviderQuantity,
  type AgentDraft,
  type LaunchProgress,
} from "./setup/setupModel";

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
    if (launchLock.current || !canEnterWorkspace(project)) return;
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
          const terminal = agent
            ? useTerminalStore.getState().sessions[agent.terminalId]
            : undefined;
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
                terminal?.error ||
                useAgentStore.getState().launchError?.message ||
                (agent
                  ? providerLaunchFailureMessage({
                      providerName: providerDisplayName(item.provider),
                      cwd: agent.cwd,
                      exitCode: terminal?.exitCode,
                    })
                  : `${providerDisplayName(item.provider)} could not start in "${project.path}". Check the CLI installation and terminal output.`),
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
    <div className="setup-screen absolute inset-0 z-40 overflow-y-auto text-paper">
      <div className="setup-container">
            <header className="setup-topbar">
              <div className="flex items-center gap-2.5">
            <ZliMark className="h-6 w-6" />
            <p className="text-[13px] font-semibold tracking-tight">ZLI</p>
          </div>

          <span className="flex-1" aria-hidden="true" />

          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={busy}
              onClick={() => setHelpOpen(true)}
              aria-label="Help"
              title="Help"
            >
              <IconHelp />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={busy}
              onClick={() => setPreferencesOpen(true)}
              aria-label="Preferences"
              title="Preferences"
            >
              <IconSettings />
            </Button>
          </div>
        </header>

        <main className="setup-main">
          <div className="setup-content-single">
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
                  onOpenRecent={(recentPath) => {
                    void openFromPath(recentPath).then((opened) => {
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

          </div>
        </main>
      </div>
    </div>
  );
}
