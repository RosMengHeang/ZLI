import { useEffect, useMemo, useState } from "react";
import {
  IconAgents,
  IconCheck,
  IconClock,
  IconGit,
  IconGlobe,
  IconGrid,
  IconGrip,
  IconHelp,
  IconHome,
  IconInfo,
  IconPlus,
  IconSettings,
  IconTrash,
  TaxzyMark,
} from "./AppIcons";
import { ProviderIcon } from "./ProviderIcon";
import { useAgentStore } from "../stores/agentStore";
import { useProjectStore } from "../stores/projectStore";
import { useUiStore } from "../stores/uiStore";
import type { AgentProviderId } from "../types";
import { PROVIDER_CATALOG, providerDisplayName } from "../types";
import { getLastProjectPath } from "../lib/preferences";
import { newId } from "../lib/ids";

const MAX_AGENTS = 6;
const STEP_LABELS = ["Project", "Agents", "Review"] as const;

interface SetupWizardProps {
  onComplete: () => void;
}

type SetupStep = 1 | 2 | 3;

interface AgentDraft {
  id: string;
  provider: AgentProviderId;
  role: string;
  count: number;
  isolatedWorktree: boolean;
}

const FEATURES = [
  { title: "Multiple AI agents", body: "Run Claude, Codex, Cursor, and more side by side.", tone: "#7c3aed", icon: "agents" },
  { title: "Isolated worktrees", body: "Give each agent its own Git checkout when you want isolation.", tone: "#16a34a", icon: "git" },
  { title: "Built-in browser", body: "Keep docs and previews open beside the team.", tone: "#2563eb", icon: "globe" },
  { title: "Simple & powerful", body: "A calm workspace with terminals, diffs, and review in one place.", tone: "#ea580c", icon: "check" },
] as const;

export function SetupWizard({ onComplete }: SetupWizardProps) {
  const project = useProjectStore((state) => state.project);
  const loadingProject = useProjectStore((state) => state.loading);
  const openFromDialog = useProjectStore((state) => state.openFromDialog);
  const openFromPath = useProjectStore((state) => state.openFromPath);
  const setPathDialogOpen = useUiStore((state) => state.setPathDialogOpen);
  const setHelpOpen = useUiStore((state) => state.setHelpOpen);
  const providers = useAgentStore((state) => state.providers);
  const loadProviders = useAgentStore((state) => state.loadProviders);
  const launch = useAgentStore((state) => state.launch);
  const launching = useAgentStore((state) => state.launching);
  const launchError = useAgentStore((state) => state.launchError);

  const [step, setStep] = useState<SetupStep>(project ? 2 : 1);
  const [pathDraft, setPathDraft] = useState(getLastProjectPath() ?? "");
  const [rows, setRows] = useState<AgentDraft[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [startingIndex, setStartingIndex] = useState(0);
  const [setupError, setSetupError] = useState<string | null>(null);
  const lastProjectPath = getLastProjectPath();

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  const displayedStep = step;
  const busy = launching || startingIndex > 0;
  const plannedCount = rows.reduce((sum, row) => sum + row.count, 0);

  const providerStatus = useMemo(() => {
    const map = new Map(providers.map((provider) => [provider.id, provider]));
    return map;
  }, [providers]);

  function openProjectPicker() {
    setSetupError(null);
    void openFromDialog().then((result) => {
      if (result === "failed") setPathDialogOpen(true);
    });
  }

  function addRow(provider: AgentProviderId) {
    setRows((current) => [
      ...current,
      {
        id: newId(),
        provider,
        role: provider === "shell" ? "Dev Terminal" : "",
        count: 1,
        isolatedWorktree: provider !== "shell",
      },
    ]);
    setPickerOpen(false);
  }

  function updateRow(id: string, patch: Partial<AgentDraft>) {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  function removeRow(id: string) {
    setRows((current) => current.filter((row) => row.id !== id));
  }

  function onDrop(targetId: string) {
    if (!dragId || dragId === targetId) return;
    setRows((current) => {
      const from = current.findIndex((row) => row.id === dragId);
      const to = current.findIndex((row) => row.id === targetId);
      if (from < 0 || to < 0) return current;
      const next = [...current];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
    setDragId(null);
  }

  async function createWorkspace() {
    if (!project) {
      setSetupError("Select a project folder first.");
      setStep(1);
      return;
    }
    if (plannedCount > MAX_AGENTS) {
      setSetupError(`Keep the mix at ${MAX_AGENTS} agents or fewer.`);
      return;
    }

    setSetupError(null);
    if (rows.length === 0) {
      useUiStore.getState().setBrowserOpen(true);
      onComplete();
      return;
    }

    setStartingIndex(1);
    let started = 0;
    let failed = 0;
    let index = 0;
    for (const row of rows) {
      for (let copy = 0; copy < row.count; copy += 1) {
        index += 1;
        setStartingIndex(index);
        const baseName = row.role.trim() || providerDisplayName(row.provider);
        const name = row.count > 1 ? `${baseName} ${copy + 1}` : baseName;
        const agent = await launch({
          name,
          provider: row.provider,
          createWorktree: row.isolatedWorktree,
        });
        if (agent) started += 1;
        else failed += 1;
      }
    }
    setStartingIndex(0);

    if (failed > 0 && started === 0) {
      const lastError = useAgentStore.getState().launchError?.message;
      setSetupError(
        lastError ?? "None of the selected agents could start. Check the tool installation and try again.",
      );
      return;
    }
    useUiStore.getState().setBrowserOpen(true);
    onComplete();
  }

  return (
    <div className="absolute inset-0 z-40 bg-ink">
      <div className="grid h-full min-h-0 grid-cols-[220px_minmax(0,1fr)_300px]">
        <aside className="flex h-full flex-col border-r border-line bg-panel px-3 py-4">
          <div className="mb-6 flex items-center gap-2 px-1">
            <TaxzyMark className="h-7 w-7" />
            <span className="text-[14px] font-semibold tracking-tight">Taxzy</span>
            <span className="beta-badge">BETA</span>
          </div>
          <nav className="flex flex-col gap-0.5">
            <div className="nav-item" data-active="true">
              <IconHome />
              New Workspace
            </div>
            <button
              type="button"
              className="nav-item"
              disabled={!lastProjectPath || loadingProject}
              onClick={() => lastProjectPath && void openFromPath(lastProjectPath)}
            >
              <IconClock />
              Open Recent
            </button>
            <button type="button" className="nav-item" disabled title="No templates yet">
              <IconGrid />
              Templates
            </button>
          </nav>
          <div className="mt-auto flex flex-col gap-0.5">
            <button type="button" className="nav-item" onClick={() => setHelpOpen(true)}>
              <IconSettings />
              Settings
            </button>
            <button type="button" className="nav-item" onClick={() => setHelpOpen(true)}>
              <IconHelp />
              Help & Feedback
            </button>
          </div>
        </aside>

        <main className="min-h-0 overflow-auto px-10 py-8">
          <div className="mb-6 flex items-start justify-between gap-4">
            <div>
              <h1 className="text-[28px] font-semibold tracking-tight text-paper">Create a new workspace</h1>
              <p className="mt-1 text-[14px] text-mute">Select your project and set up your AI development team.</p>
            </div>
            <button type="button" className="btn btn-ghost" onClick={onComplete}>
              Skip for now
            </button>
          </div>

          <div className="mb-8 flex items-center gap-3">
            {STEP_LABELS.map((label, index) => {
              const itemStep = (index + 1) as SetupStep;
              const complete = displayedStep > itemStep;
              const active = displayedStep === itemStep;
              return (
                <button
                  key={label}
                  type="button"
                  className="flex items-center gap-2"
                  onClick={() => setStep(itemStep)}
                >
                  <span
                    className={`flex h-7 w-7 items-center justify-center rounded-full text-[12px] font-semibold ${
                      active || complete ? "bg-accent text-white" : "bg-raised text-mute"
                    }`}
                  >
                    {complete ? <IconCheck className="h-3.5 w-3.5" /> : itemStep}
                  </span>
                  <span className={`text-[13px] ${active ? "text-paper" : "text-mute"}`}>{label}</span>
                  {index < STEP_LABELS.length - 1 ? <span className="mx-1 text-line">→</span> : null}
                </button>
              );
            })}
          </div>

          {displayedStep === 1 ? (
            <section>
              <h2 className="text-[15px] font-semibold text-paper">Select project folder</h2>
              <div className="mt-3 flex gap-2">
                <input
                  className="field font-mono"
                  value={project?.path ?? pathDraft}
                  onChange={(event) => setPathDraft(event.target.value)}
                  placeholder="C:\Projects\my-awesome-project"
                  aria-label="Project folder"
                />
                <button type="button" className="btn btn-quiet h-[2.15rem] shrink-0" onClick={openProjectPicker}>
                  Browse...
                </button>
              </div>
              {!project ? (
                <div className="mt-2 flex gap-3">
                  <button
                    type="button"
                    className="text-[12px] text-branch hover:underline"
                    onClick={() => setPathDialogOpen(true)}
                  >
                    Enter path manually
                  </button>
                  {pathDraft.trim() ? (
                    <button
                      type="button"
                      className="text-[12px] text-mute hover:text-paper hover:underline"
                      onClick={() => void openFromPath(pathDraft.trim())}
                      disabled={loadingProject}
                    >
                      Open this path
                    </button>
                  ) : null}
                </div>
              ) : (
                <div className="banner banner-ok mt-3 flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 font-medium">
                      <IconCheck className="h-3.5 w-3.5" />
                      Git repository detected
                    </div>
                    <div className="mt-1 text-[12px] text-paper/80">
                      {project.currentBranch}
                      <span className="mx-1.5 text-ok/50">·</span>
                      {project.clean ? "Clean" : "Uncommitted changes"}
                    </div>
                  </div>
                  <button type="button" className="btn btn-ghost h-7" onClick={openProjectPicker}>
                    Change
                  </button>
                </div>
              )}
              <div className="mt-6 flex justify-end">
                <button type="button" className="btn btn-primary h-8 px-4" onClick={() => setStep(2)} disabled={!project}>
                  Continue
                </button>
              </div>
            </section>
          ) : null}

          {displayedStep === 2 ? (
            <section>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-[15px] font-semibold text-paper">Configure your agents</h2>
                <div className="relative">
                  <button type="button" className="btn btn-quiet h-8" onClick={() => setPickerOpen((open) => !open)}>
                    <IconPlus />
                    Add Agent
                  </button>
                  {pickerOpen ? (
                    <div className="absolute right-0 z-10 mt-1 w-72 overflow-hidden rounded-xl border border-line bg-panel p-1 shadow-xl">
                      {PROVIDER_CATALOG.map((item) => {
                        const detected = providerStatus.get(item.id);
                        const ready = item.id === "shell" || Boolean(detected?.installed);
                        return (
                          <button
                            key={item.id}
                            type="button"
                            className="provider-card border-transparent bg-transparent"
                            data-disabled={!ready}
                            disabled={!ready}
                            onClick={() => addRow(item.id)}
                          >
                            <ProviderIcon provider={item.id} size="sm" />
                            <span className="min-w-0 flex-1 text-left">
                              <span className="block truncate text-[12px] font-medium">{item.displayName}</span>
                              <span className="block text-[11px] text-mute">
                                {ready ? "Ready" : "Not found on this machine"}
                              </span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              </div>
              {rows.length === 0 ? (
                <div className="rounded-xl border border-dashed border-line px-4 py-8 text-center text-[13px] text-mute">
                  Add an agent or a terminal to your team.
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {rows.map((row) => (
                    <div
                      key={row.id}
                      className="flex items-center gap-2 rounded-xl border border-line bg-chrome px-2 py-2"
                      draggable
                      onDragStart={() => setDragId(row.id)}
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={() => onDrop(row.id)}
                    >
                      <span className="cursor-grab text-mute" title="Drag to reorder">
                        <IconGrip />
                      </span>
                      <ProviderIcon provider={row.provider} size="md" />
                      <div className="w-28 shrink-0 truncate text-[12px] font-medium text-paper">
                        {providerDisplayName(row.provider)}
                      </div>
                      <input
                        className="field h-8 flex-1"
                        value={row.role}
                        placeholder="Role"
                        onChange={(event) => updateRow(row.id, { role: event.target.value })}
                        aria-label={`${providerDisplayName(row.provider)} role`}
                      />
                      <select
                        className="field h-8 w-14 px-1"
                        value={row.count}
                        onChange={(event) => updateRow(row.id, { count: Number(event.target.value) })}
                        aria-label="Count"
                      >
                        {Array.from({ length: MAX_AGENTS }, (_, index) => index + 1).map((value) => (
                          <option key={value} value={value}>
                            {value}
                          </option>
                        ))}
                      </select>
                      <label className="flex items-center gap-1.5 text-[11px] text-mute" title="Create a separate Git worktree for this agent">
                        <input
                          type="checkbox"
                          checked={row.isolatedWorktree}
                          onChange={(event) => updateRow(row.id, { isolatedWorktree: event.target.checked })}
                        />
                        Isolated worktree
                        <IconInfo className="h-3 w-3" />
                      </label>
                      <button
                        type="button"
                        className="btn btn-icon"
                        aria-label="Remove agent"
                        onClick={() => removeRow(row.id)}
                      >
                        <IconTrash />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-6 flex justify-between">
                <button type="button" className="btn btn-ghost" onClick={() => setStep(1)}>
                  Back
                </button>
                <button type="button" className="btn btn-primary h-8 px-4" onClick={() => setStep(3)}>
                  Review
                </button>
              </div>
            </section>
          ) : null}

          {displayedStep === 3 ? (
            <section>
              <h2 className="text-[15px] font-semibold text-paper">Review and create</h2>
              <p className="mt-1 text-[13px] text-mute">You'll be able to start all agents at once.</p>
              <div className="mt-4 rounded-xl border border-line bg-chrome p-4">
                <div className="text-[13px] font-medium text-paper">{project?.name ?? "No project"}</div>
                <div className="mt-1 font-mono text-[12px] text-mute">{project?.path}</div>
                <div className="mt-3 flex flex-col gap-2">
                  {rows.length === 0 ? (
                    <div className="text-[12px] text-mute">No agents yet — you can add them after the workspace opens.</div>
                  ) : (
                    rows.map((row) => (
                      <div key={row.id} className="flex items-center gap-2 text-[12px]">
                        <ProviderIcon provider={row.provider} size="sm" />
                        <span className="text-paper">
                          {row.role.trim() || providerDisplayName(row.provider)}
                          {row.count > 1 ? ` ×${row.count}` : ""}
                        </span>
                        <span className="text-mute">
                          {row.isolatedWorktree ? "isolated worktree" : "shared working tree"}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
              {setupError || launchError ? (
                <div className="banner banner-warn mt-3">{setupError ?? launchError?.message}</div>
              ) : null}
              {busy ? (
                <div className="mt-3 text-[12px] text-branch">
                  Starting agent {startingIndex} of {plannedCount}…
                </div>
              ) : null}
              <div className="mt-6 flex items-center justify-between">
                <button type="button" className="btn btn-ghost" onClick={() => setStep(2)} disabled={busy}>
                  Back
                </button>
                <button
                  type="button"
                  className="btn btn-primary h-10 px-5 text-[13px]"
                  onClick={() => void createWorkspace()}
                  disabled={busy || !project}
                >
                  {busy ? "Starting workspace…" : "Create Workspace →"}
                </button>
              </div>
            </section>
          ) : null}
        </main>

        <aside className="flex h-full flex-col border-l border-line bg-panel px-5 py-8">
          <h2 className="text-[18px] font-semibold leading-6 text-paper">Turn ideas into reality</h2>
          <p className="mt-2 text-[13px] leading-5 text-mute">Your AI development team, ready to go.</p>
          <div className="mt-5 flex flex-col gap-2.5">
            {FEATURES.map((feature) => (
              <div key={feature.title} className="rounded-xl border border-line bg-ink p-3">
                <div className="feature-icon text-white" style={{ background: feature.tone }}>
                  {feature.icon === "agents" ? <IconAgents className="h-3.5 w-3.5" /> : null}
                  {feature.icon === "git" ? <IconGit className="h-3.5 w-3.5" /> : null}
                  {feature.icon === "globe" ? <IconGlobe className="h-3.5 w-3.5" /> : null}
                  {feature.icon === "check" ? <IconCheck className="h-3.5 w-3.5" /> : null}
                </div>
                <div className="mt-2 text-[13px] font-medium text-paper">{feature.title}</div>
                <div className="mt-1 text-[12px] leading-5 text-mute">{feature.body}</div>
              </div>
            ))}
          </div>
          <div className="relative mt-6 h-28">
            <div className="mini-window absolute left-0 top-4 h-20 w-28 p-2">
              <div className="font-mono text-[9px] leading-3 text-ok">$ yarn run dev</div>
              <div className="mt-1 font-mono text-[9px] text-mute">localhost:3000</div>
            </div>
            <div className="mini-window absolute left-10 top-0 h-[5.5rem] w-32 p-2">
              <div className="h-2 w-16 rounded bg-raised" />
              <div className="mt-2 h-8 rounded bg-accent/30" />
            </div>
            <div className="mini-window absolute right-0 top-6 h-[4.5rem] w-28 p-2">
              <div className="h-2 w-full rounded bg-line" />
              <div className="mt-2 h-2 w-3/4 rounded bg-line" />
            </div>
          </div>
          <p className="mt-auto pt-6 text-[12px] italic text-mute">A calm, focused environment for building with AI.</p>
        </aside>
      </div>
    </div>
  );
}
