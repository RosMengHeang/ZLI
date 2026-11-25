import type {
  AgentLogin,
  ForgeCliStatus,
  HistoryFolder,
  ListedProviderKind,
  ProjectProjection,
  ProviderDiscovery,
  RuntimeProjection,
} from "@zli-v2/contracts";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { listedDiscoveries } from "../agent/providers.js";
import { forgesStatus, rescanForges } from "../forges/forgesClient.js";
import { openExternalLink } from "../review/links.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";
import { BranchStatus } from "../sessions/BranchStatus.js";
import { samePath } from "../sessions/launch.js";
import type { NewAgentRequest } from "../sessions/NewAgentDialog.js";
import { type BranchRead, readBranchState } from "../sessions/projectBranch.js";
import { relativeTime } from "../sessions/sessions.js";
import {
  readAppSettings,
  resolveLaunchDefaults,
  updateAppSettings,
  withWorkStyle,
  workStyleOf,
} from "../settings/appSettings.js";
import { ConnectorLogo } from "../settings/connectorLogos.js";
import { Button, IconButton } from "../ui/Button.js";
import { Dialog } from "../ui/Dialog.js";
import { Icon } from "../ui/Icon.js";
import { ProviderMark } from "../ui/ProviderMark.js";
import { ZliLogo } from "../ui/ZliLogo.js";
import { WelcomeIntro } from "./WelcomeIntro.js";
import { WelcomeTour } from "./WelcomeTour.js";
import {
  agentReady,
  allFolders,
  defaultAgent,
  failedFoldersMessage,
  installCommand,
  installPlatform,
  introStatus,
  landingPath,
  planLabel,
  preselect,
  selectedFolders,
  signInCommand,
  WELCOME_STEPS,
  type WelcomeStep,
  welcomeAgents,
} from "./welcome.js";
import { type Dispatch, discoverProviders, scanHistory } from "./welcomeClient.js";
import "./welcome.css";

type Style = "chat" | "terminal";
type ForgeRead = ForgeCliStatus | "loading" | { error: string };

/** The intro stays up at least this long, so its entrance plays out even when every check answers at once. */
const INTRO_MIN_MS = 1600;
/** A check that never answers must not hold the intro: after this the person can go on regardless. */
const INTRO_MAX_MS = 6000;

/**
 * First-run setup. It takes the whole window, like a native app's first launch. An intro greets the
 * person while ZLI looks around, then one calm column per step, a progress line and the actions at the
 * bottom. Agents and the folders past agent sessions ran in are
 * found on their own; the only real choice is how new agents open. Projects come in empty: the first
 * agent starts a fresh session.
 */
export function WelcomeDialog({
  projection,
  dispatch,
  pickFolder,
  registerProjectPath,
  onStart,
  onDone,
}: {
  projection: RuntimeProjection;
  dispatch: Dispatch;
  /** Unset outside the desktop app, where there is no folder picker. */
  pickFolder: (() => Promise<string | undefined>) | undefined;
  registerProjectPath(path: string): Promise<{ project: ProjectProjection; existing: boolean } | { error: string }>;
  onStart(request: NewAgentRequest): Promise<string | undefined>;
  /** Finished or skipped. Either way the flow does not come back on its own. */
  onDone(): void;
}) {
  const [intro, setIntro] = useState(true);
  const [step, setStep] = useState<WelcomeStep>("agents");
  const [forge, setForge] = useState<ForgeRead>("loading");
  const [introElapsed, setIntroElapsed] = useState<"early" | "min" | "max">("early");
  const [providers, setProviders] = useState<ProviderDiscovery[]>(() => listedDiscoveries(projection.providers));
  const [style, setStyle] = useState<Style>(() =>
    workStyleOf(readAppSettings().defaults) === "terminal" ? "terminal" : "chat",
  );
  const [folders, setFolders] = useState<HistoryFolder[] | "loading" | { error: string }>("loading");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [added, setAdded] = useState<ProjectProjection[]>([]);
  // What git says about each added folder, by project.
  const [branches, setBranches] = useState<Record<string, BranchRead>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const primary = useRef<HTMLButtonElement>(null);
  const stage = useRef<HTMLElement>(null);
  const picking = useRef(false);
  // Folders that were added before a later one failed, so a retry does not add them twice.
  const registered = useRef<ProjectProjection[]>([]);

  // Discovery can land after setup opened; the list follows it until the person checks again by hand.
  const refreshed = useRef(false);
  useEffect(() => {
    if (!refreshed.current && projection.providers) setProviders(listedDiscoveries(projection.providers));
  }, [projection.providers]);

  const loadHistory = async () => {
    setFolders("loading");
    const result = await scanHistory(dispatch);
    setFolders(result.ok ? result.value : { error: result.error });
    if (result.ok) setSelected(preselect(result.value));
  };
  const loadForge = async (rescan = false) => {
    setForge("loading");
    try {
      const result = await (rescan ? rescanForges(dispatch) : forgesStatus(dispatch));
      const github = result.forges.find((entry) => entry.kind === "github");
      setForge(github ?? { error: "ZLI could not check the GitHub CLI." });
    } catch (cause) {
      setForge({ error: cause instanceof Error ? cause.message : "ZLI could not check the GitHub CLI." });
    }
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: the scans run once, when setup opens.
  useEffect(() => {
    void loadHistory();
    void loadForge();
    const min = setTimeout(() => setIntroElapsed("min"), INTRO_MIN_MS);
    const max = setTimeout(() => setIntroElapsed("max"), INTRO_MAX_MS);
    return () => {
      clearTimeout(min);
      clearTimeout(max);
    };
  }, []);

  // Each step starts with focus on the page, so Tab reaches its controls in order and Enter moves on.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refocus only when the step changes.
  useEffect(() => {
    if (!intro) stage.current?.focus();
  }, [step, intro]);

  // The agent new chats start with. Setup picks one, and the person can choose any other ready agent.
  const [chosenAgent, setChosenAgent] = useState<ListedProviderKind>();
  const agent = defaultAgent(providers, chosenAgent ?? readAppSettings().defaults.provider);
  const installed = providers.filter((entry) => entry.status === "found");
  const ready = installed.filter(agentReady);
  const index = WELCOME_STEPS.findIndex((candidate) => candidate.id === step);
  const found = Array.isArray(folders) ? folders : [];
  const picked = selectedFolders(found, selected);
  const projectCount =
    picked.length + added.filter((project) => !picked.some((folder) => samePath(folder.path, project.path))).length;

  const markDone = () => updateAppSettings((current) => ({ ...current, onboardedAt: new Date().toISOString() }));
  const skip = () => {
    if (busy) return;
    markDone();
    onDone();
  };

  const saveChoices = () =>
    updateAppSettings((current) => ({
      ...current,
      defaults: withWorkStyle(
        { ...current.defaults, ...(agent ? { provider: agent.provider } : {}) },
        // Chat + terminal set in Settings stays, since setup only offers the two views.
        style === "chat" && current.defaults.withTerminal ? "chat-terminal" : style,
      ),
    }));

  const addFolder = async () => {
    // One picker at a time: a double click must not open two.
    if (!pickFolder || picking.current || busy) return;
    picking.current = true;
    setError(undefined);
    let path: string | undefined;
    let result: Awaited<ReturnType<typeof registerProjectPath>>;
    try {
      path = await pickFolder();
      if (!path) return;
      result = await registerProjectPath(path);
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : "Could not open the folder picker.");
      return;
    } finally {
      picking.current = false;
    }
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setAdded((current) =>
      current.some((project) => project.projectId === result.project.projectId)
        ? current
        : [...current, result.project],
    );
    // A folder that was already found is ticked again rather than listed twice.
    const match = Array.isArray(folders) ? folders.find((folder) => samePath(folder.path, path)) : undefined;
    if (match) setSelected((current) => new Set([...current, match.path]));
    await readBranch(result.project.projectId);
  };

  const readBranch = async (projectId: string) => {
    setBranches((current) => ({ ...current, [projectId]: { status: "loading" } }));
    const read = await readBranchState(dispatch, projectId);
    setBranches((current) => ({ ...current, [projectId]: read }));
  };

  const finish = async () => {
    setError(undefined);
    setBusy(true);
    saveChoices();
    const projects = [...added, ...registered.current];
    const failed: string[] = [];
    for (const folder of picked) {
      if (projects.some((project) => samePath(project.path, folder.path))) continue;
      const result = await registerProjectPath(folder.path);
      if ("error" in result) failed.push(folder.name);
      else {
        projects.push(result.project);
        registered.current.push(result.project);
      }
    }
    // Stop and name the failures, even when others were added; those are not added twice on retry.
    if (failed.length > 0) {
      setBusy(false);
      setError(failedFoldersMessage(failed));
      return;
    }
    const path = landingPath(found, selected, added);
    const project = path ? projects.find((candidate) => samePath(candidate.path, path)) : undefined;
    if (project && agent) {
      const defaults = resolveLaunchDefaults(readAppSettings(), project.projectId);
      const failure = await onStart({
        project,
        placement: { kind: "checkout" },
        provider: agent.provider,
        mode: style,
        draft: style === "chat",
        permissionMode: defaults.permissionMode ?? "supervised",
        ...(defaults.provider === agent.provider && defaults.model ? { model: defaults.model } : {}),
      });
      if (failure) {
        setBusy(false);
        setError(failure);
        return;
      }
    }
    setBusy(false);
    markDone();
    onDone();
  };

  const next = () => {
    setError(undefined);
    if (step === "agents") setStep("tour");
    else if (step === "tour") setStep("style");
    else if (step === "style") {
      saveChoices();
      setStep("projects");
    } else void finish();
  };

  const back = () => {
    if (busy) return;
    setError(undefined);
    setStep(WELCOME_STEPS[index - 1]?.id ?? "agents");
  };

  const landing = landingPath(found, selected, added);
  const landingName = landing
    ? (added.find((project) => samePath(project.path, landing))?.name ??
      found.find((folder) => folder.path === landing)?.name)
    : undefined;
  const agentsKnown = projection.providers !== undefined || providers.length > 0;
  const introChecks = {
    agents: agentsKnown ? installed.length : undefined,
    github:
      forge === "loading"
        ? undefined
        : "state" in forge
          ? forge.state === "ready"
            ? ("ready" as const)
            : forge.state === "missing"
              ? ("missing" as const)
              : ("found" as const)
          : ("missing" as const),
    projects: folders === "loading" ? undefined : found.length,
  };
  const introDone = [introChecks.agents, introChecks.github, introChecks.projects].filter(
    (value) => value !== undefined,
  ).length;
  const introReady = introElapsed === "max" || (introElapsed === "min" && introDone === 3);

  const note = error ? (
    <span className="welcome-error" role="alert">
      <Icon name="alert" size={13} />
      {error}
    </span>
  ) : busy ? (
    "Adding projects…"
  ) : step === "agents" ? (
    installed.length === 0 ? (
      "Install an agent, then check again."
    ) : ready.length === 0 ? (
      `Sign in to ${installed[0]?.displayName ?? "an agent"} to use it, then check again.`
    ) : ready.length < installed.length ? (
      `${ready.length} ready · ${signedOutNames(installed)} ${installed.length - ready.length === 1 ? "needs" : "need"} to sign in`
    ) : (
      `${ready.length} ${ready.length === 1 ? "agent" : "agents"} ready`
    )
  ) : step === "projects" && agent ? (
    landingName ? (
      `Opens ${agent.displayName} in ${landingName}`
    ) : (
      "Add a project any time from the sidebar"
    )
  ) : null;

  return (
    <Dialog
      label="Welcome to ZLI"
      size="lg"
      className="welcome-screen"
      showClose={false}
      stacked
      initialFocusRef={stage}
      onClose={skip}
    >
      <header className="welcome-bar">
        <span className="welcome-brand">
          <ZliLogo size={18} />
          ZLI
        </span>
        <button type="button" className="welcome-skip" onClick={skip} disabled={busy}>
          Skip setup
        </button>
      </header>
      {intro ? (
        <main className="welcome-stage is-intro">
          <WelcomeIntro
            progress={introDone / 3}
            status={introStatus(introChecks)}
            ready={introReady}
            onContinue={() => setIntro(false)}
          />
        </main>
      ) : (
        <>
          {/* Focus lands on the page itself, so Tab reaches the step's controls in order and Enter can continue. */}
          <main
            ref={stage}
            className="welcome-stage"
            tabIndex={-1}
            onKeyDown={(event) => {
              if (event.key === "Enter" && event.target === event.currentTarget && !primary.current?.disabled) next();
            }}
          >
            <div className="welcome-column" key={step}>
              {step === "agents" ? (
                <AgentsStep
                  providers={providers}
                  agent={agent}
                  onPick={setChosenAgent}
                  dispatch={dispatch}
                  onRefreshed={(value) => {
                    refreshed.current = true;
                    setProviders(listedDiscoveries(value));
                  }}
                  forge={forge}
                  onCheckForge={() => void loadForge(true)}
                />
              ) : step === "tour" ? (
                <WelcomeTour />
              ) : step === "style" ? (
                <StyleStep value={style} agent={agent} onChange={setStyle} />
              ) : (
                <ProjectsStep
                  folders={folders}
                  selected={selected}
                  added={added}
                  branches={branches}
                  onRetryBranch={(projectId) => void readBranch(projectId)}
                  canPickFolder={pickFolder !== undefined}
                  busy={busy}
                  onToggle={(path) =>
                    setSelected((current) => {
                      const next = new Set(current);
                      if (next.has(path)) next.delete(path);
                      else next.add(path);
                      return next;
                    })
                  }
                  onAddFolder={() => void addFolder()}
                  onSelectAll={(all) => setSelected(all && Array.isArray(folders) ? allFolders(folders) : new Set())}
                  onRemoveFolder={(projectId) =>
                    setAdded((current) => current.filter((project) => project.projectId !== projectId))
                  }
                  onRetry={() => void loadHistory()}
                />
              )}
            </div>
          </main>
          <footer className="welcome-actions-bar">
            <ol className="welcome-dots" aria-label={`Step ${index + 1} of ${WELCOME_STEPS.length}`}>
              {WELCOME_STEPS.map((candidate, position) => (
                <li
                  key={candidate.id}
                  className={position === index ? "is-current" : position < index ? "is-done" : undefined}
                  aria-current={position === index ? "step" : undefined}
                >
                  <span className="welcome-visually-hidden">{candidate.label}</span>
                </li>
              ))}
            </ol>
            <span className="welcome-note" aria-live="polite">
              {note}
            </span>
            {index > 0 ? (
              <Button onClick={back} disabled={busy}>
                Back
              </Button>
            ) : null}
            <Button
              ref={primary}
              variant="primary"
              loading={busy}
              disabled={step === "agents" && installed.length === 0}
              onClick={next}
            >
              {step !== "projects"
                ? "Continue"
                : projectCount > 0
                  ? `Add ${projectCount} ${projectCount === 1 ? "project" : "projects"} and open`
                  : "Open ZLI"}
            </Button>
          </footer>
        </>
      )}
    </Dialog>
  );
}

function StepHeader({ title, dim, children }: { title: string; dim?: string; children?: ReactNode }) {
  return (
    <header className="welcome-head">
      <h1 className="welcome-title">
        {title}
        {dim ? <span className="welcome-title-dim"> {dim}</span> : null}
      </h1>
      {children ? <p className="welcome-lede">{children}</p> : null}
    </header>
  );
}

function AgentsStep({
  providers,
  agent,
  onPick,
  dispatch,
  onRefreshed,
  forge,
  onCheckForge,
}: {
  providers: readonly ProviderDiscovery[];
  agent: ProviderDiscovery | undefined;
  onPick(provider: ListedProviderKind): void;
  dispatch: Dispatch;
  onRefreshed(providers: ProviderDiscovery[]): void;
  forge: ForgeRead;
  onCheckForge(): void;
}) {
  const [showMore, setShowMore] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string>();
  const { shown, more } = welcomeAgents(providers);
  const platform = installPlatform(typeof navigator === "undefined" ? "" : navigator.userAgent);
  const checkAgain = async () => {
    setChecking(true);
    setCheckError(undefined);
    onCheckForge();
    const result = await discoverProviders(dispatch);
    setChecking(false);
    if (result.ok) onRefreshed(result.value);
    else setCheckError(result.error);
  };
  const tile = (entry: ProviderDiscovery) => (
    <AgentTile
      key={entry.provider}
      entry={entry}
      primary={entry.provider === agent?.provider}
      command={entry.status === "missing" ? installCommand(entry.provider, platform) : undefined}
      onPick={() => onPick(entry.provider)}
    />
  );
  return (
    <>
      <StepHeader title="Choose your agent." dim="One is enough to start.">
        ZLI found the coding agents on this computer. New chats start with the one you pick, and you can switch in any
        chat.
      </StepHeader>
      {providers.length === 0 ? (
        <p className="welcome-loading">
          <span className="spinner" aria-hidden="true" />
          Looking for agents…
        </p>
      ) : (
        <div className="welcome-tiles" role="radiogroup" aria-label="Agents">
          {shown.map(tile)}
          {showMore ? more.map(tile) : null}
        </div>
      )}
      <GithubRow forge={forge} />
      <div className="welcome-under">
        {more.length > 0 ? (
          <button type="button" className="welcome-link" onClick={() => setShowMore((value) => !value)}>
            {showMore ? "Show fewer" : `${more.length} more agents ZLI supports`}
          </button>
        ) : (
          <span />
        )}
        <button type="button" className="welcome-link" disabled={checking} onClick={() => void checkAgain()}>
          {checking ? <span className="spinner" aria-hidden="true" /> : <Icon name="reload" size={12} />}
          Check again
        </button>
      </div>
      {checkError ? <p className="welcome-under-note is-warning">{checkError}</p> : null}
    </>
  );
}

/** One agent as a tile: its mark and state on top, its name and status at the foot. */
function AgentTile({
  entry,
  primary,
  command,
  onPick,
}: {
  entry: ProviderDiscovery;
  primary: boolean;
  command: string | undefined;
  onPick(): void;
}) {
  const found = entry.status === "found";
  const login = found ? entry.login : undefined;
  const signedOut = login?.status === "signed-out";
  const signIn = signedOut ? signInCommand(entry.provider) : undefined;
  const account = login?.status === "signed-in" ? accountLine(login) : undefined;
  const version = found ? entry.version : undefined;
  if (found && agentReady(entry)) {
    return (
      <label className={`welcome-tile is-ready${primary ? " is-picked" : ""}`} title={account ?? version}>
        <input
          type="radio"
          name="welcome-default-agent"
          className="welcome-tile-input"
          checked={primary}
          onChange={onPick}
          aria-describedby={`welcome-agent-${entry.provider}`}
        />
        <span className="welcome-tile-top">
          <ProviderMark provider={entry.provider} size={22} />
          <span className="welcome-tile-check" aria-hidden="true">
            <Icon name="check" size={12} />
          </span>
        </span>
        <span className="welcome-tile-name">{entry.displayName}</span>
        <span className="welcome-tile-detail" id={`welcome-agent-${entry.provider}`}>
          {primary ? "Default" : "Ready"}
        </span>
      </label>
    );
  }
  const copy = found ? signIn : command;
  return (
    <div className={`welcome-tile${found ? " is-signed-out" : " is-missing"}`}>
      <span className="welcome-tile-top">
        <ProviderMark provider={entry.provider} size={22} />
        {copy ? (
          <CopyCommand
            label={`Copy the ${found ? "sign-in" : "install"} command for ${entry.displayName}`}
            command={copy}
          />
        ) : null}
      </span>
      <span className="welcome-tile-name">{entry.displayName}</span>
      <span className="welcome-tile-detail" title={copy}>
        {found ? "Signed out" : "Not installed"}
      </span>
    </div>
  );
}

/** The GitHub CLI, which ZLI uses for pull requests. It is optional, so it never blocks setup. */
function GithubRow({ forge }: { forge: ForgeRead }) {
  const { bridge } = useRuntime();
  const state = forge === "loading" ? "loading" : "state" in forge ? forge.state : "error";
  const detail =
    forge === "loading"
      ? "Checking…"
      : !("state" in forge)
        ? forge.error
        : forge.state === "ready"
          ? (forge.accounts[0]?.login ?? forge.accounts[0]?.host ?? "Signed in")
          : forge.state === "signed_out"
            ? `Installed, not signed in. Run ${forge.signInCommand}`
            : forge.state === "outdated"
              ? `ZLI needs gh ${forge.minimumVersion} or newer`
              : forge.state === "missing"
                ? "Optional. ZLI uses it to open pull requests."
                : (forge.message ?? "gh gave an answer ZLI could not read.");
  return (
    <div className={`welcome-forge is-${state}`}>
      <span className="welcome-forge-mark">
        <ConnectorLogo id="github" title="GitHub" size={20} />
      </span>
      <span className="welcome-row-copy">
        <span className="welcome-row-title">GitHub CLI</span>
        <span className="welcome-row-detail">{detail}</span>
      </span>
      {forge === "loading" ? (
        <span className="spinner" aria-hidden="true" />
      ) : !("state" in forge) ? null : forge.state === "ready" ? (
        <span className="welcome-tile-check is-static" role="img" aria-label="Ready">
          <Icon name="check" size={12} />
        </span>
      ) : forge.state === "signed_out" ? (
        <CopyCommand label="Copy the GitHub CLI sign-in command" command={forge.signInCommand} />
      ) : forge.state === "error" ? null : (
        <Button size="sm" onClick={() => void openExternalLink(bridge, forge.installUrl)}>
          {forge.state === "outdated" ? "Update gh" : "Get gh"}
        </Button>
      )}
    </div>
  );
}

function signedOutNames(installed: readonly ProviderDiscovery[]): string {
  return installed
    .filter((entry) => !agentReady(entry))
    .map((entry) => entry.displayName)
    .join(" and ");
}

/** "kim@gmail.com · Pro", or how the agent signs in when its account has no email to show. */
function accountLine(login: AgentLogin): string {
  // Some agents keep the login but not the email, so the row still says the account is there.
  const who = login.email ?? (login.method === "api-key" ? "API key" : "Signed in");
  return login.plan ? `${who} · ${planLabel(login.plan)}` : who;
}

function CopyCommand({ label, command }: { label: string; command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <IconButton
      label={label}
      tooltip={copied ? "Copied" : "Copy command"}
      icon={copied ? "check" : "copy"}
      size="sm"
      onClick={() => {
        void navigator.clipboard?.writeText(command).then(
          () => setCopied(true),
          () => undefined,
        );
      }}
    />
  );
}

function StyleStep({
  value,
  agent,
  onChange,
}: {
  value: Style;
  agent: ProviderDiscovery | undefined;
  onChange(value: Style): void;
}) {
  const name = agent?.displayName ?? "the agent";
  const options: { id: Style; title: string; detail: string; preview: ReactNode }[] = [
    {
      id: "chat",
      title: "Chat",
      detail: `Messages with ${name}, every step it takes, and the diff of each turn.`,
      preview: <ChatPreview agent={agent} />,
    },
    {
      id: "terminal",
      title: "Terminal",
      detail: `${name}'s own CLI, exactly as it runs in your shell.`,
      preview: <TerminalPreview agent={agent} />,
    },
  ];
  return (
    <>
      <StepHeader title="How do you want to work?">
        New agents open this way. Any agent can still start the other way.
      </StepHeader>
      <div className="welcome-choices" role="radiogroup" aria-label="How new agents open">
        {options.map((option) => (
          <label className="welcome-choice" key={option.id}>
            <input
              type="radio"
              name="welcome-style"
              value={option.id}
              checked={value === option.id}
              onChange={() => onChange(option.id)}
            />
            {option.preview}
            <span className="welcome-choice-copy">
              <span className="welcome-choice-title">
                {option.title}
                {option.id === "chat" ? <span className="welcome-tag">Recommended</span> : null}
              </span>
              <span className="welcome-choice-detail">{option.detail}</span>
            </span>
            <span className="welcome-radio" aria-hidden="true" />
          </label>
        ))}
      </div>
      <p className="welcome-under-note">Want both? Settings has Chat + terminal, a chat with a shell under it.</p>
    </>
  );
}

/** The chat tile at a small size, drawn with the app's own surfaces and type. */
function ChatPreview({ agent }: { agent: ProviderDiscovery | undefined }) {
  return (
    <span className="welcome-preview" aria-hidden="true">
      <span className="preview-bubble">Fix the flaky login test</span>
      <span className="preview-step">
        <Icon name="check" size={10} />
        Edited <b>login.spec.ts</b>
        <span className="preview-plus">+6</span>
        <span className="preview-minus">−2</span>
      </span>
      <span className="preview-reply">The test read a stale token. It now waits for sign-in.</span>
      <span className="preview-composer">
        {agent ? <ProviderMark provider={agent.provider} size={10} /> : null}
        Ask {agent?.displayName ?? "the agent"}…
      </span>
    </span>
  );
}

/** The terminal tile at a small size, running the agent's CLI. */
function TerminalPreview({ agent }: { agent: ProviderDiscovery | undefined }) {
  return (
    <span className="welcome-preview is-terminal" aria-hidden="true">
      <span className="preview-line is-dim">{agent?.displayName ?? "agent"} · ~/repo</span>
      <span className="preview-line">
        <span className="preview-prompt">›</span> Fix the flaky login test
      </span>
      <span className="preview-line is-dim">● Read tests/login.spec.ts</span>
      <span className="preview-line is-dim">● Update tests/login.spec.ts (+6 −2)</span>
      <span className="preview-line">● The test read a stale token.</span>
      <span className="preview-line">
        <span className="preview-prompt">›</span>
        <span className="preview-cursor" />
      </span>
    </span>
  );
}

function ProjectsStep({
  folders,
  selected,
  added,
  branches,
  onRetryBranch,
  canPickFolder,
  busy,
  onToggle,
  onSelectAll,
  onAddFolder,
  onRemoveFolder,
  onRetry,
}: {
  folders: HistoryFolder[] | "loading" | { error: string };
  selected: ReadonlySet<string>;
  added: readonly ProjectProjection[];
  branches: Readonly<Record<string, BranchRead>>;
  onRetryBranch(projectId: string): void;
  canPickFolder: boolean;
  busy: boolean;
  onToggle(path: string): void;
  onSelectAll(all: boolean): void;
  onAddFolder(): void;
  onRemoveFolder(projectId: string): void;
  onRetry(): void;
}) {
  const found = Array.isArray(folders) ? folders : [];
  // A picked folder that was already found keeps its history row, so the branch shows there.
  const branchOf = (path: string) => added.find((candidate) => samePath(candidate.path, path))?.projectId;
  const branchStatus = (projectId: string | undefined) =>
    projectId ? (
      <BranchStatus
        className="welcome-folder-branch"
        read={branches[projectId]}
        onRetry={() => onRetryBranch(projectId)}
      />
    ) : null;
  return (
    <>
      <StepHeader title="Pick your projects." dim="Bring in as many as you like.">
        {found.length > 0
          ? "ZLI found these folders in your Claude Code and Codex history. Tick the ones to bring in."
          : "Add a folder to work in. Folders from your Claude Code and Codex history show up here too."}
      </StepHeader>
      {folders === "loading" ? (
        <p className="welcome-loading">
          <span className="spinner" aria-hidden="true" />
          Looking for your projects…
        </p>
      ) : !Array.isArray(folders) ? (
        <div className="welcome-under">
          <span className="welcome-under-note is-warning">{folders.error}</span>
          <Button size="sm" icon="reload" onClick={onRetry}>
            Try again
          </Button>
        </div>
      ) : null}
      {found.length > 1 ? (
        <div className="welcome-pick-bar">
          <span className="welcome-pick-count">
            {found.filter((folder) => selected.has(folder.path)).length} of {found.length} selected
          </span>
          <button
            type="button"
            className="welcome-link"
            disabled={busy}
            onClick={() => onSelectAll(!found.every((folder) => selected.has(folder.path)))}
          >
            {found.every((folder) => selected.has(folder.path)) ? "Clear all" : "Select all"}
          </button>
        </div>
      ) : null}
      <ul className="welcome-rows" aria-label="Projects">
        {found.map((folder) => (
          <li className="welcome-row is-folder" key={folder.path}>
            <label className="welcome-folder-pick">
              <input
                className="welcome-check"
                type="checkbox"
                checked={selected.has(folder.path)}
                disabled={busy}
                onChange={() => onToggle(folder.path)}
              />
              <span className="welcome-row-copy">
                <span className="welcome-row-title">{folder.name}</span>
                <span className="welcome-row-detail is-mono">{folder.path}</span>
              </span>
              {branchStatus(branchOf(folder.path))}
              <span className="welcome-folder-meta">
                <span className="welcome-folder-marks">
                  {folder.sources.map((source) => (
                    <ProviderMark key={source} provider={source} size={13} />
                  ))}
                </span>
                {relativeTime(folder.lastActiveAt)}
              </span>
            </label>
          </li>
        ))}
        {added
          .filter((project) => !found.some((folder) => samePath(folder.path, project.path)))
          .map((project) => (
            <li className="welcome-row" key={project.projectId}>
              <span className="welcome-mark">
                <Icon name="folder" size={15} />
              </span>
              <span className="welcome-row-copy">
                <span className="welcome-row-title">{project.name}</span>
                <span className="welcome-row-detail is-mono">{project.path}</span>
              </span>
              {branchStatus(project.projectId)}
              <IconButton
                label={`Remove ${project.name}`}
                tooltip="Remove"
                icon="x"
                size="sm"
                disabled={busy}
                onClick={() => onRemoveFolder(project.projectId)}
              />
            </li>
          ))}
        {canPickFolder ? (
          <li className="welcome-row is-action">
            <button type="button" className="welcome-row-button" onClick={onAddFolder} disabled={busy}>
              <span className="welcome-mark">
                <Icon name="plus" size={15} />
              </span>
              <span className="welcome-row-copy">
                <span className="welcome-row-title">Add a folder</span>
                <span className="welcome-row-detail">Any repository on this computer</span>
              </span>
            </button>
          </li>
        ) : null}
      </ul>
    </>
  );
}
