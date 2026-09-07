import { useMemo, useState } from "react";
import { useAgentStore } from "../stores/agentStore";
import { useProjectStore } from "../stores/projectStore";
import { useUiStore } from "../stores/uiStore";
import type { AgentProvider } from "../types";
import { providerDisplayName } from "../types";

const MAX_AGENTS = 6;

interface SetupWizardProps {
  onComplete: () => void;
}

type SetupStep = 1 | 2 | 3;

const STEP_LABELS = ["Project", "Tools", "Agents"] as const;

function providerInitials(provider: AgentProvider): string {
  const words = provider.displayName.split(/\s+/).filter(Boolean);
  if (words.length > 1) return words.map((word) => word[0]).join("").slice(0, 2).toUpperCase();
  return provider.displayName.slice(0, 2).toUpperCase();
}

function availableProvider(provider: AgentProvider): boolean {
  return provider.id === "shell" || provider.installed;
}

function assignedTotal(
  quantities: Record<string, number>,
  providers: AgentProvider[],
): number {
  return providers.reduce((total, provider) => total + (quantities[provider.id] ?? 0), 0);
}

export function SetupWizard({ onComplete }: SetupWizardProps) {
  const project = useProjectStore((state) => state.project);
  const loadingProject = useProjectStore((state) => state.loading);
  const openFromDialog = useProjectStore((state) => state.openFromDialog);
  const setPathDialogOpen = useUiStore((state) => state.setPathDialogOpen);
  const providers = useAgentStore((state) => state.providers);
  const providersLoaded = useAgentStore((state) => state.providersLoaded);
  const providersError = useAgentStore((state) => state.providersError);
  const loadProviders = useAgentStore((state) => state.loadProviders);
  const launch = useAgentStore((state) => state.launch);
  const launching = useAgentStore((state) => state.launching);
  const launchError = useAgentStore((state) => state.launchError);

  const [step, setStep] = useState<SetupStep>(project ? 2 : 1);
  const [totalAgents, setTotalAgents] = useState(1);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [startingIndex, setStartingIndex] = useState(0);
  const [setupError, setSetupError] = useState<string | null>(null);

  const availableProviders = useMemo(
    () => providers.filter(availableProvider),
    [providers],
  );
  const assigned = assignedTotal(quantities, availableProviders);
  const busy = launching || startingIndex > 0;

  function openProjectPicker() {
    setSetupError(null);
    void openFromDialog().then((result) => {
      if (result === "failed") setPathDialogOpen(true);
    });
  }

  function continueToAgents() {
    if (assigned === 0 && availableProviders[0]) {
      setQuantities({ [availableProviders[0].id]: 1 });
    }
    setStep(3);
  }

  function setAgentTotal(value: number) {
    const nextTotal = Math.min(MAX_AGENTS, Math.max(1, value));
    setTotalAgents(nextTotal);
    setQuantities((current) => {
      let remaining = nextTotal;
      const next: Record<string, number> = {};
      for (const provider of availableProviders) {
        const kept = Math.min(current[provider.id] ?? 0, remaining);
        if (kept > 0) next[provider.id] = kept;
        remaining -= kept;
      }
      return next;
    });
  }

  function changeQuantity(providerId: string, delta: number) {
    setQuantities((current) => {
      const currentValue = current[providerId] ?? 0;
      if (delta > 0 && assigned >= totalAgents) return current;
      const nextValue = Math.max(0, currentValue + delta);
      if (nextValue === 0) {
        const next = { ...current };
        delete next[providerId];
        return next;
      }
      return { ...current, [providerId]: nextValue };
    });
  }

  async function startWorkspace() {
    if (assigned !== totalAgents) {
      setSetupError(`Assign all ${totalAgents} agent${totalAgents === 1 ? "" : "s"} before starting.`);
      return;
    }

    const plan = availableProviders.flatMap((provider) =>
      Array.from({ length: quantities[provider.id] ?? 0 }, (_, index) => ({
        provider,
        index,
      })),
    );
    if (plan.length === 0) {
      setSetupError("Choose at least one detected tool to start.");
      return;
    }

    setSetupError(null);
    setStartingIndex(1);
    let started = 0;
    let failed = 0;
    for (const [index, item] of plan.entries()) {
      setStartingIndex(index + 1);
      const agent = await launch({
        name: `${providerDisplayName(item.provider.id)} ${item.index + 1}`,
        provider: item.provider.id,
        createWorktree: true,
      });
      if (agent) started += 1;
      else failed += 1;
    }
    setStartingIndex(0);

    if (failed > 0 && started === 0) {
      const lastError = useAgentStore.getState().launchError?.message;
      setSetupError(lastError ?? "None of the selected agents could start. Check the tool installation and try again.");
      return;
    }
    onComplete();
  }

  const displayedStep = project ? Math.max(2, step) as SetupStep : 1;

  return (
    <div className="absolute inset-0 z-40 overflow-auto bg-[#151719]">
      <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col px-6 py-8">
        <div className="flex items-start justify-between gap-6">
          <div>
            <div className="mb-3 inline-flex items-center gap-2 border border-[#31556d] bg-[#1c2c38] px-2 py-1 text-[10px] font-medium text-[#9cdcfe]">
              <span className="h-1.5 w-1.5 rounded-full bg-[#4ec9b0]" />
              Taxzy workspace setup
            </div>
            <h1 className="max-w-xl text-2xl font-semibold tracking-tight text-white">
              Build your agent workspace in a minute.
            </h1>
            <p className="mt-2 max-w-xl text-[13px] leading-6 text-[#9b9da1]">
              Pick a project, discover the coding tools already on this machine, and start the
              exact mix of agents you need.
            </p>
          </div>
          <button
            type="button"
            className="shrink-0 px-2 py-1 text-[11px] text-[#8b8b8b] hover:bg-[#2a2d2e] hover:text-white"
            onClick={onComplete}
          >
            Skip for now
          </button>
        </div>

        <div className="mt-8 flex items-center gap-2 border-b border-[#2d3034] pb-4">
          {STEP_LABELS.map((label, index) => {
            const itemStep = (index + 1) as SetupStep;
            const complete = displayedStep > itemStep;
            const active = displayedStep === itemStep;
            return (
              <div key={label} className="flex items-center gap-2">
                <div
                  className={`flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold ${
                    active || complete ? "bg-[#0e639c] text-white" : "bg-[#2a2d2e] text-[#8b8b8b]"
                  }`}
                >
                  {complete ? "✓" : itemStep}
                </div>
                <span className={`text-[11px] ${active ? "text-white" : "text-[#8b8b8b]"}`}>
                  {label}
                </span>
                {index < STEP_LABELS.length - 1 ? <span className="mx-1 text-[#50545a]">/</span> : null}
              </div>
            );
          })}
        </div>

        <div className="mt-6 flex-1">
          {displayedStep === 1 ? (
            <section className="mx-auto max-w-2xl">
              <div className="mb-5">
                <p className="text-[11px] font-medium text-[#4ec9b0]">Step 1</p>
                <h2 className="mt-1 text-lg font-semibold text-white">Choose your project</h2>
                <p className="mt-1 text-[12px] text-[#9b9da1]">
                  Taxzy keeps terminals, agents, worktrees, and Git review scoped to this folder.
                </p>
              </div>
              {project ? (
                <div className="border border-[#355c70] bg-[#1c2c38] p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="text-[14px] font-semibold text-white">{project.name}</div>
                      <div className="mt-1 truncate font-mono text-[11px] text-[#9cdcfe]">{project.path}</div>
                      <div className="mt-2 text-[11px] text-[#89d185]">Git repository · {project.currentBranch}</div>
                    </div>
                    <button
                      type="button"
                      className="h-7 shrink-0 border border-[#4a4d51] px-3 text-[11px] text-[#cccccc] hover:bg-[#2a2d2e]"
                      onClick={openProjectPicker}
                    >
                      Change folder
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className="group flex w-full items-center gap-4 border border-dashed border-[#4a4d51] bg-[#1d1f22] p-5 text-left hover:border-[#4ec9b0] hover:bg-[#20272a]"
                  onClick={openProjectPicker}
                  disabled={loadingProject}
                >
                  <span className="flex h-12 w-12 items-center justify-center rounded-lg bg-[#263b43] text-xl text-[#4ec9b0]">⌂</span>
                  <span>
                    <span className="block text-[14px] font-semibold text-white">{loadingProject ? "Opening project…" : "Choose a Git folder"}</span>
                    <span className="mt-1 block text-[11px] text-[#9b9da1]">Use the native folder picker, or enter a path if you prefer.</span>
                  </span>
                  <span className="ml-auto text-xl text-[#8b8b8b] transition-transform group-hover:translate-x-1">›</span>
                </button>
              )}
              <div className="mt-4 flex items-center justify-between">
                <button type="button" className="text-[11px] text-[#9cdcfe] hover:underline" onClick={() => setPathDialogOpen(true)}>
                  Enter path manually
                </button>
                <button
                  type="button"
                  className="h-8 bg-[#0e639c] px-4 text-[11px] font-medium text-white hover:bg-[#1177bb] disabled:opacity-40"
                  onClick={() => setStep(2)}
                  disabled={!project}
                >
                  Continue to tool scan
                </button>
              </div>
            </section>
          ) : null}

          {displayedStep === 2 ? (
            <section className="mx-auto max-w-3xl">
              <div className="mb-5 flex items-end justify-between gap-4">
                <div>
                  <p className="text-[11px] font-medium text-[#4ec9b0]">Step 2</p>
                  <h2 className="mt-1 text-lg font-semibold text-white">Your local tools</h2>
                  <p className="mt-1 text-[12px] text-[#9b9da1]">We scan PATH only. Nothing is uploaded or installed.</p>
                </div>
                <button type="button" className="text-[11px] text-[#9cdcfe] hover:underline" onClick={() => void loadProviders()}>
                  Scan again
                </button>
              </div>
              {providersError ? (
                <div className="mb-4 border border-[#6b3a2f] bg-[#33251f] px-3 py-2 text-[11px] text-[#f4b183]">
                  {providersError.message}
                </div>
              ) : null}
              {!providersLoaded ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  {[0, 1, 2, 3].map((item) => <div key={item} className="h-24 animate-pulse border border-[#303338] bg-[#1d1f22]" />)}
                </div>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  {providers.map((provider) => {
                    const ready = availableProvider(provider);
                    return (
                      <div key={provider.id} className={`border p-3 ${ready ? "border-[#355c70] bg-[#1c2c38]" : "border-[#303338] bg-[#1d1f22] opacity-70"}`}>
                        <div className="flex items-start gap-3">
                          <span className={`flex h-9 w-9 items-center justify-center rounded-md text-[11px] font-semibold ${ready ? "bg-[#284653] text-[#9cdcfe]" : "bg-[#2b2d30] text-[#8b8b8b]"}`}>
                            {providerInitials(provider)}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-2">
                              <span className="truncate text-[13px] font-medium text-white">{provider.displayName}</span>
                              <span className={`text-[10px] ${ready ? "text-[#89d185]" : "text-[#8b8b8b]"}`}>
                                {provider.id === "shell" ? "Always ready" : provider.installed ? "Detected" : "Not found"}
                              </span>
                            </div>
                            <div className="mt-1 truncate font-mono text-[10px] text-[#8b8b8b]">
                              {provider.installed ? provider.executable : provider.id === "shell" ? "Your system shell" : "Install this tool to use it"}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              <div className="mt-5 flex items-center justify-between">
                <button type="button" className="h-8 px-3 text-[11px] text-[#9b9da1] hover:bg-[#2a2d2e] hover:text-white" onClick={() => setStep(1)}>
                  Back
                </button>
                <button type="button" className="h-8 bg-[#0e639c] px-4 text-[11px] font-medium text-white hover:bg-[#1177bb]" onClick={continueToAgents}>
                  Choose agent mix
                </button>
              </div>
            </section>
          ) : null}

          {displayedStep === 3 ? (
            <section className="mx-auto max-w-3xl">
              <div className="mb-5">
                <p className="text-[11px] font-medium text-[#4ec9b0]">Step 3</p>
                <h2 className="mt-1 text-lg font-semibold text-white">Shape your workspace</h2>
                <p className="mt-1 text-[12px] text-[#9b9da1]">Choose the total number of agents, then split them across the tools you detected.</p>
              </div>
              <div className="flex items-center justify-between border border-[#303338] bg-[#1d1f22] p-4">
                <div>
                  <div className="text-[13px] font-medium text-white">Total agents</div>
                  <div className="mt-1 text-[11px] text-[#8b8b8b]">Each agent gets its own terminal pane.</div>
                </div>
                <div className="flex items-center gap-3">
                  <button type="button" className="h-8 w-8 border border-[#4a4d51] text-lg text-white hover:bg-[#2a2d2e] disabled:opacity-40" onClick={() => setAgentTotal(totalAgents - 1)} disabled={busy || totalAgents <= 1}>−</button>
                  <span className="w-5 text-center text-lg font-semibold text-white">{totalAgents}</span>
                  <button type="button" className="h-8 w-8 border border-[#4a4d51] text-lg text-white hover:bg-[#2a2d2e] disabled:opacity-40" onClick={() => setAgentTotal(totalAgents + 1)} disabled={busy || totalAgents >= MAX_AGENTS}>+</button>
                </div>
              </div>
              <div className="mt-3 divide-y divide-[#303338] border border-[#303338] bg-[#1d1f22]">
                {availableProviders.map((provider) => {
                  const quantity = quantities[provider.id] ?? 0;
                  return (
                    <div key={provider.id} className="flex items-center gap-3 px-4 py-3">
                      <span className="flex h-8 w-8 items-center justify-center rounded-md bg-[#284653] text-[10px] font-semibold text-[#9cdcfe]">{providerInitials(provider)}</span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[12px] font-medium text-white">{provider.displayName}</div>
                        <div className="truncate text-[10px] text-[#8b8b8b]">{provider.executable || "System shell"}</div>
                      </div>
                      <button type="button" className="h-7 w-7 border border-[#4a4d51] text-base text-white hover:bg-[#2a2d2e] disabled:opacity-40" onClick={() => changeQuantity(provider.id, -1)} disabled={busy || quantity === 0}>−</button>
                      <span className="w-5 text-center text-[12px] font-semibold text-white">{quantity}</span>
                      <button type="button" className="h-7 w-7 border border-[#4a4d51] text-base text-white hover:bg-[#2a2d2e] disabled:opacity-40" onClick={() => changeQuantity(provider.id, 1)} disabled={busy || assigned >= totalAgents}>+</button>
                    </div>
                  );
                })}
              </div>
              <div className={`mt-3 text-[11px] ${assigned === totalAgents ? "text-[#89d185]" : "text-[#cca700]"}`}>
                {assigned === totalAgents ? `${assigned} agent${assigned === 1 ? "" : "s"} ready to start.` : `${assigned} of ${totalAgents} assigned · add ${totalAgents - assigned} more.`}
              </div>
              {setupError || launchError ? <div className="mt-3 border border-[#6b3a2f] bg-[#33251f] px-3 py-2 text-[11px] text-[#f4b183]">{setupError ?? launchError?.message}</div> : null}
              {busy ? <div className="mt-3 text-[11px] text-[#9cdcfe]">Starting agent {startingIndex} of {totalAgents}…</div> : null}
              <div className="mt-5 flex items-center justify-between">
                <button type="button" className="h-8 px-3 text-[11px] text-[#9b9da1] hover:bg-[#2a2d2e] hover:text-white" onClick={() => setStep(2)} disabled={busy}>Back</button>
                <button type="button" className="h-8 bg-[#0e639c] px-4 text-[11px] font-medium text-white hover:bg-[#1177bb] disabled:opacity-40" onClick={() => void startWorkspace()} disabled={busy || assigned !== totalAgents}>
                  {busy ? "Starting workspace…" : `Start ${totalAgents} agent${totalAgents === 1 ? "" : "s"}`}
                </button>
              </div>
            </section>
          ) : null}
        </div>

        <div className="mt-8 flex items-center justify-between border-t border-[#2d3034] pt-3 text-[10px] text-[#686b70]">
          <span>{project ? `${project.name} · ${project.currentBranch}` : "No project selected"}</span>
          <span>Local-first · no account required</span>
        </div>
      </div>
    </div>
  );
}
