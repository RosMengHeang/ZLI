import type { HistoryFolder, ProjectProjection, ProviderDiscovery, RuntimeProjection } from "@zli-v2/contracts";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { listedDiscoveries } from "../agent/providers.js";
import { makeCommandId } from "../runtime/commandId.js";
import { samePath } from "../sessions/launch.js";
import type { NewAgentRequest } from "../sessions/NewAgentDialog.js";
import { relativeTime } from "../sessions/sessions.js";
import {
  readAppSettings,
  resolveLaunchDefaults,
  updateAppSettings,
  withWorkStyle,
  workStyleOf,
} from "../settings/appSettings.js";
import { Button, IconButton } from "../ui/Button.js";
import { Dialog } from "../ui/Dialog.js";
import { Icon } from "../ui/Icon.js";
import { ProviderMark } from "../ui/ProviderMark.js";
import { ZliLogo } from "../ui/ZliLogo.js";
import {
  chatKey,
  defaultAgent,
  folderState,
  type ImportPlan,
  importableChats,
  importPlan,
  installCommand,
  installPlatform,
  landing,
  preselect,
  sourceLabel,
  toggleFolder,
  WELCOME_STEPS,
  type WelcomeStep,
  welcomeAgents,
} from "./welcome.js";
import { type Dispatch, discoverProviders, importChat, scanHistory } from "./welcomeClient.js";
import "./welcome.css";

type Style = "chat" | "terminal";
type Imported = { sessionId: string; projectId: string; lastActiveAt: string };

/**
 * First-run setup. It takes the whole window, like a native app's first launch: one calm column, a
 * progress line and the actions at the bottom. Agents and past project folders are found on their own;
 * the only real choice is how new agents open.
 */
export function WelcomeDialog({
  projection,
  dispatch,
  pickFolder,
  registerProjectPath,
  checkoutFor,
  onImported,
  onStart,
  onDone,
}: {
  projection: RuntimeProjection;
  dispatch: Dispatch;
  /** Unset outside the desktop app, where there is no folder picker. */
  pickFolder: (() => Promise<string | undefined>) | undefined;
  registerProjectPath(path: string): Promise<{ project: ProjectProjection; existing: boolean } | { error: string }>;
  checkoutFor(project: ProjectProjection): Promise<{ worktreeId: string } | { error: string }>;
  /** Imported chats wait in the sidebar; `show` is the one to open on the board, if any. */
  onImported(sessionIds: readonly string[], show?: { sessionId: string; projectId: string }): void;
  onStart(request: NewAgentRequest): Promise<string | undefined>;
  /** Finished or skipped. Either way the flow does not come back on its own. */
  onDone(): void;
}) {
  const [step, setStep] = useState<WelcomeStep>("agents");
  const [providers, setProviders] = useState<ProviderDiscovery[]>(() => listedDiscoveries(projection.providers));
  const [style, setStyle] = useState<Style>(() =>
    workStyleOf(readAppSettings().defaults) === "terminal" ? "terminal" : "chat",
  );
  const [folders, setFolders] = useState<HistoryFolder[] | "loading" | { error: string }>("loading");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [added, setAdded] = useState<ProjectProjection[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number }>();
  const [error, setError] = useState<string>();
  const primary = useRef<HTMLButtonElement>(null);
  const stage = useRef<HTMLElement>(null);

  // Discovery can land after setup opened; the list follows it until the person checks again by hand.
  const refreshed = useRef(false);
  useEffect(() => {
    if (!refreshed.current && projection.providers) setProviders(listedDiscoveries(projection.providers));
  }, [projection.providers]);

  const loadHistory = async (pick: boolean) => {
    setFolders("loading");
    const result = await scanHistory(dispatch);
    setFolders(result.ok ? result.value : { error: result.error });
    if (pick && result.ok) setSelected(preselect(result.value));
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: the scan runs once, when setup opens.
  useEffect(() => {
    void loadHistory(true);
  }, []);

  // Each step starts with focus on the page, so Tab reaches its controls in order and Enter moves on.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refocus only when the step changes.
  useEffect(() => {
    stage.current?.focus();
  }, [step]);

  const agent = defaultAgent(providers, readAppSettings().defaults.provider);
  const ready = providers.filter((entry) => entry.status === "found");
  const index = WELCOME_STEPS.findIndex((candidate) => candidate.id === step);
  const plan = Array.isArray(folders) ? importPlan(folders, selected) : [];
  const chatCount = plan.reduce((count, folder) => count + folder.chats.length, 0);
  const projectCount =
    plan.length +
    added.filter((project) => !plan.some((folder) => folder.path.toLowerCase() === project.path.toLowerCase())).length;
  const busy = progress !== undefined;

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
    if (!pickFolder) return;
    setError(undefined);
    const path = await pickFolder();
    if (!path) return;
    const result = await registerProjectPath(path);
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
    if (match) setSelected((current) => new Set([...current, ...importableChats(match).map(chatKey)]));
  };

  const runImport = async (work: ImportPlan): Promise<{ imported: Imported[]; failed: number }> => {
    const total = work.reduce((count, folder) => count + folder.chats.length, 0);
    const active = new Map(
      (Array.isArray(folders) ? folders : []).flatMap((folder) =>
        folder.chats.map((chat) => [chatKey(chat), chat.lastActiveAt]),
      ),
    );
    let done = 0;
    let failed = 0;
    const imported: Imported[] = [];
    setProgress({ done, total });
    for (const folder of work) {
      const registered = await registerProjectPath(folder.path);
      const checkout = "error" in registered ? registered : await checkoutFor(registered.project);
      if ("error" in registered || "error" in checkout) {
        failed += folder.chats.length;
        done += folder.chats.length;
        setProgress({ done, total });
        continue;
      }
      for (const chat of folder.chats) {
        const sessionId = makeCommandId();
        const result = await importChat(dispatch, { ...chat, worktreeId: checkout.worktreeId, sessionId });
        if (result.ok) {
          imported.push({
            sessionId,
            projectId: registered.project.projectId,
            lastActiveAt: active.get(chatKey(chat)) ?? "",
          });
        } else failed += 1;
        done += 1;
        setProgress({ done, total });
      }
    }
    return { imported, failed };
  };

  const finish = async () => {
    setError(undefined);
    saveChoices();
    const { imported, failed } = plan.length > 0 ? await runImport(plan) : { imported: [], failed: 0 };
    if (failed > 0 && imported.length === 0) {
      setProgress(undefined);
      setError(`${failed} ${failed === 1 ? "chat" : "chats"} could not be imported. Try again, or untick them.`);
      await loadHistory(false);
      return;
    }
    const target = landing({ style, added, imported });
    onImported(
      imported.map((entry) => entry.sessionId),
      target.kind === "show" ? { sessionId: target.sessionId, projectId: target.projectId } : undefined,
    );
    if (target.kind === "start" && agent) {
      const project =
        added.find((candidate) => candidate.projectId === target.projectId) ??
        projection.projects.find((candidate) => candidate.projectId === target.projectId);
      if (project) {
        const defaults = resolveLaunchDefaults(readAppSettings(), project.projectId);
        const failure = await onStart({
          project,
          placement: { kind: "checkout" },
          provider: agent.provider,
          mode: style,
          permissionMode: defaults.permissionMode ?? "supervised",
          ...(defaults.provider === agent.provider && defaults.model ? { model: defaults.model } : {}),
        });
        if (failure) {
          setProgress(undefined);
          setError(failure);
          return;
        }
      }
    }
    setProgress(undefined);
    markDone();
    onDone();
  };

  const next = () => {
    setError(undefined);
    if (step === "agents") setStep("style");
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

  const landingName = added.at(-1)?.name ?? plan.at(-1)?.name;
  const note = error ? (
    <span className="welcome-error" role="alert">
      <Icon name="alert" size={13} />
      {error}
    </span>
  ) : progress ? (
    `Importing ${progress.done} of ${progress.total}…`
  ) : step === "agents" ? (
    ready.length === 0 ? (
      "Install an agent, then check again."
    ) : (
      `${ready.length} ${ready.length === 1 ? "agent" : "agents"} ready`
    )
  ) : step === "projects" && agent ? (
    landingName ? (
      added.length > 0 || style === "terminal" ? (
        `Opens ${agent.displayName} in ${landingName}`
      ) : (
        `Opens your newest chat in ${landingName}`
      )
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
              dispatch={dispatch}
              onRefreshed={(value) => {
                refreshed.current = true;
                setProviders(listedDiscoveries(value));
              }}
            />
          ) : step === "style" ? (
            <StyleStep value={style} agent={agent} onChange={setStyle} />
          ) : (
            <ProjectsStep
              folders={folders}
              selected={selected}
              added={added}
              canPickFolder={pickFolder !== undefined}
              busy={busy}
              onToggle={setSelected}
              onAddFolder={() => void addFolder()}
              onRemoveFolder={(projectId) =>
                setAdded((current) => current.filter((project) => project.projectId !== projectId))
              }
              onRetry={() => void loadHistory(true)}
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
          disabled={step === "agents" && ready.length === 0}
          onClick={next}
        >
          {step !== "projects"
            ? "Continue"
            : chatCount > 0
              ? `Import ${projectCount} ${projectCount === 1 ? "project" : "projects"} and open`
              : "Open ZLI"}
        </Button>
      </footer>
    </Dialog>
  );
}

function StepHeader({ step, title, children }: { step: number; title: string; children: ReactNode }) {
  return (
    <header className="welcome-head">
      <span className="welcome-step-count">Step {step} of 3</span>
      <h1 className="welcome-title">{title}</h1>
      <p className="welcome-lede">{children}</p>
    </header>
  );
}

function AgentsStep({
  providers,
  agent,
  dispatch,
  onRefreshed,
}: {
  providers: readonly ProviderDiscovery[];
  agent: ProviderDiscovery | undefined;
  dispatch: Dispatch;
  onRefreshed(providers: ProviderDiscovery[]): void;
}) {
  const [showMore, setShowMore] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string>();
  const { shown, more } = welcomeAgents(providers);
  const platform = installPlatform(typeof navigator === "undefined" ? "" : navigator.userAgent);
  const checkAgain = async () => {
    setChecking(true);
    setCheckError(undefined);
    const result = await discoverProviders(dispatch);
    setChecking(false);
    if (result.ok) onRefreshed(result.value);
    else setCheckError(result.error);
  };
  const row = (entry: ProviderDiscovery) => (
    <AgentRow
      key={entry.provider}
      entry={entry}
      primary={entry.provider === agent?.provider}
      command={entry.status === "missing" ? installCommand(entry.provider, platform) : undefined}
    />
  );
  return (
    <>
      <StepHeader step={1} title="Your agents">
        ZLI found the coding agents on this computer. They sign in with their own accounts.
      </StepHeader>
      {providers.length === 0 ? (
        <p className="welcome-loading">
          <span className="spinner" aria-hidden="true" />
          Looking for agents…
        </p>
      ) : (
        <ul className="welcome-rows" aria-label="Agents">
          {shown.map(row)}
          {showMore ? more.map(row) : null}
        </ul>
      )}
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

function AgentRow({
  entry,
  primary,
  command,
}: {
  entry: ProviderDiscovery;
  primary: boolean;
  command: string | undefined;
}) {
  const [copied, setCopied] = useState(false);
  const found = entry.status === "found";
  return (
    <li className={`welcome-row${found ? "" : " is-missing"}`}>
      <span className="welcome-mark">
        <ProviderMark provider={entry.provider} size={18} />
      </span>
      <span className="welcome-row-copy">
        <span className="welcome-row-title">
          {entry.displayName}
          {primary ? <span className="welcome-tag">Default</span> : null}
        </span>
        {found ? (
          <span className="welcome-row-detail is-mono">{entry.version ?? "Installed"}</span>
        ) : command ? (
          <span className="welcome-row-detail">
            Install with <code>{command}</code>
          </span>
        ) : (
          <span className="welcome-row-detail">Not installed</span>
        )}
      </span>
      {found ? (
        <span className="welcome-ready">Ready</span>
      ) : command ? (
        <IconButton
          label={`Copy the install command for ${entry.displayName}`}
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
      ) : null}
    </li>
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
      <StepHeader step={2} title="How do you want to work?">
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
  canPickFolder,
  busy,
  onToggle,
  onAddFolder,
  onRemoveFolder,
  onRetry,
}: {
  folders: HistoryFolder[] | "loading" | { error: string };
  selected: ReadonlySet<string>;
  added: readonly ProjectProjection[];
  canPickFolder: boolean;
  busy: boolean;
  onToggle(next: Set<string>): void;
  onAddFolder(): void;
  onRemoveFolder(projectId: string): void;
  onRetry(): void;
}) {
  const found = Array.isArray(folders) ? folders.filter((folder) => folder.exists) : [];
  const gone = Array.isArray(folders) ? folders.length - found.length : 0;
  return (
    <>
      <StepHeader step={3} title="Your projects">
        {found.length > 0
          ? "ZLI found these from your Claude Code and Codex chats. They come in with their chats; untick any you don't want."
          : "Add a folder to work in. Projects from your Claude Code and Codex chats show up here too."}
      </StepHeader>
      {folders === "loading" ? (
        <p className="welcome-loading">
          <span className="spinner" aria-hidden="true" />
          Looking for projects in your past chats…
        </p>
      ) : !Array.isArray(folders) ? (
        <div className="welcome-under">
          <span className="welcome-under-note is-warning">{folders.error}</span>
          <Button size="sm" icon="reload" onClick={onRetry}>
            Try again
          </Button>
        </div>
      ) : null}
      <ul className="welcome-rows" aria-label="Projects">
        {found.map((folder) => (
          <FolderRow key={folder.path} folder={folder} selected={selected} disabled={busy} onToggle={onToggle} />
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
      {gone > 0 ? (
        <p className="welcome-under-note">
          {gone} {gone === 1 ? "folder" : "folders"} from past chats no longer {gone === 1 ? "exists" : "exist"} and{" "}
          {gone === 1 ? "is" : "are"} left out.
        </p>
      ) : null}
    </>
  );
}

function FolderRow({
  folder,
  selected,
  disabled,
  onToggle,
}: {
  folder: HistoryFolder;
  selected: ReadonlySet<string>;
  disabled: boolean;
  onToggle(next: Set<string>): void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLInputElement>(null);
  const state = folderState(selected, folder);
  const pickable = importableChats(folder);
  const picked = pickable.filter((chat) => selected.has(chatKey(chat))).length;
  useEffect(() => {
    if (box.current) box.current.indeterminate = state === "some";
  }, [state]);
  const inZli = pickable.length === 0;
  return (
    <li className={`welcome-row is-folder${open ? " is-open" : ""}`}>
      <div className="welcome-folder-head">
        <label className="welcome-folder-pick">
          <input
            ref={box}
            className="welcome-check"
            type="checkbox"
            checked={state === "all"}
            disabled={disabled || inZli}
            onChange={() => onToggle(toggleFolder(selected, folder))}
          />
          <span className="welcome-row-copy">
            <span className="welcome-row-title">{folder.name}</span>
            <span className="welcome-row-detail is-mono">{folder.path}</span>
          </span>
        </label>
        <button type="button" className="welcome-count" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {inZli
            ? "Already in ZLI"
            : state === "some"
              ? `${picked} of ${pickable.length} chats`
              : `${folder.chats.length} ${folder.chats.length === 1 ? "chat" : "chats"}`}
          <Icon name={open ? "chevronUp" : "chevronDown"} size={12} />
        </button>
      </div>
      {open ? (
        <ul className="welcome-chats">
          {folder.chats.map((chat) => {
            const key = chatKey(chat);
            const blocked = chat.imported === true;
            return (
              <li key={key}>
                <label className={`welcome-chat${blocked ? " is-disabled" : ""}`}>
                  <input
                    className="welcome-check"
                    type="checkbox"
                    checked={selected.has(key)}
                    disabled={disabled || blocked}
                    onChange={() => {
                      const next = new Set(selected);
                      if (next.has(key)) next.delete(key);
                      else next.add(key);
                      onToggle(next);
                    }}
                  />
                  <ProviderMark provider={chat.source} size={13} />
                  <span className="welcome-chat-title" title={`${sourceLabel(chat.source)} · ${chat.title}`}>
                    {chat.title}
                  </span>
                  <span className="welcome-chat-meta">
                    {blocked ? "In ZLI" : `${chat.messageCount} msgs · ${relativeTime(chat.lastActiveAt)}`}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      ) : null}
    </li>
  );
}
