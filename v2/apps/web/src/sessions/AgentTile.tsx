import type { RpcResponse, RuntimeProjection, WorktreeProjection } from "@zli-v2/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { providerDisplayName } from "../agent/providers.js";
import { ChatBackdrop } from "../chat/ChatBackdrop.js";
import { ChatStart, ChatView, type GuestRequest, type StartRunsRequest } from "../chat/ChatView.js";
import { type DraftChange, DraftChat, type DraftMessage } from "../chat/DraftChat.js";
import { useFileLinks } from "../files/FileIndex.js";
import { makeCommandId } from "../runtime/commandId.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";
import { setupProgress, worktreeSetup } from "../setup/setup.js";
import { LazyTerminalView } from "../terminal/LazyTerminalView.js";
import { Button, IconButton } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { Menu, type MenuEntry, type MenuItem, type MenuRequest } from "../ui/Menu.js";
import { EmptyState } from "../ui/Pane.js";
import { ProviderMark } from "../ui/ProviderMark.js";
import { StopButton } from "../ui/StopButton.js";
import type { RunPosition } from "./bestOf.js";
import { customChatTitle, setChatTitle, useChatTitlesVersion } from "./chatTitles.js";
import { COMPUTER_OVERLAY_WIDTH, setComputerColumnShown, useComputerColumnShown } from "./computerColumn.js";
import { EnvironmentButton } from "./EnvironmentButton.js";
import type { ChatPlace } from "./launch.js";
import { RunsCard } from "./RunsCard.js";
import {
  type AgentSession,
  chatStatusLabel,
  relativeTime,
  type SessionChat,
  type SessionMode,
  sessionAgentName,
  sessionChats,
  sessionStatusLabel,
  sessionStopCommands,
  sessionTitle,
} from "./sessions.js";

import "./tile.css";

function chatDetail(chat: SessionChat): string {
  const age = relativeTime(chat.updatedAt);
  const when = age === "now" ? "Just now" : /^\d+[mhd]$/u.test(age) ? `${age} ago` : age;
  return [when, chatStatusLabel[chat.status]].filter(Boolean).join(" · ");
}

export function AgentTile({
  projection,
  session,
  worktree,
  active,
  maximized,
  canMaximize,
  closable = true,
  onFocus,
  onToggleMaximize,
  onStop,
  onClose,
  onOpenDiff,
  onStart,
  onRetryPending,
  onDismissPending,
  onReviewSetup,
  onShowSetupOutput,
  onSwitchAgent,
  onMoveChat,
  onOpenPullRequest,
  onDraftChange,
  onDraftMove,
  onAddFolder,
  onDraftSend,
  onOpenConnectors,
  run,
  runsCard,
  onStartRuns,
  onBringIn,
  onDiscardGuest,
  onOpenAgent,
  onBranch,
  onNewChatWithPrompt,
  onAskAside,
  onCloseAside,
  accountLabel,
  onNewChat,
  canCarryContext = false,
  onOpenChat,
  tall = false,
  onRename,
  startedBy,
  onOpenUrl,
}: {
  projection: RuntimeProjection;
  session: AgentSession;
  worktree: WorktreeProjection | undefined;
  active: boolean;
  maximized: boolean;
  canMaximize: boolean;
  /** Off when the chat fills the board alone: the sidebar switches chats, so there is nothing to close. */
  closable?: boolean | undefined;
  onFocus(): void;
  onToggleMaximize(): void;
  onStop(): void;
  onClose(): void;
  onOpenDiff(path?: string): void;
  onStart(mode: SessionMode): Promise<string | undefined>;
  onRetryPending(): void;
  onDismissPending(): void;
  onReviewSetup(): void;
  onShowSetupOutput(): void;
  /** Starts the tile's empty chat again with another agent and model. */
  onSwitchAgent?: ((provider: string, model: string | undefined) => Promise<string | undefined>) | undefined;
  /** Shows the worktree's pull request in the side panel. */
  onOpenPullRequest?: (() => void) | undefined;
  /** Moves a chat that has not started to another folder, worktree, or branch. */
  onMoveChat?: ((place: ChatPlace) => Promise<string | undefined>) | undefined;
  /** A draft chat's settings changed before its first message. */
  onDraftChange?: ((change: DraftChange) => void) | undefined;
  onDraftMove?: ((place: ChatPlace) => Promise<string | undefined>) | undefined;
  /** Adds a folder as a project (the given one, or else one picked in the folder picker), for the project menu. */
  onAddFolder?: ((path?: string) => Promise<string | undefined>) | undefined;
  /** Starts a draft chat's agent with its first message. */
  onDraftSend?: ((message: DraftMessage) => Promise<string | undefined>) | undefined;
  /** Opens Settings at a connector, for a chat that needs one. */
  onOpenConnectors?: ((connectorId?: string) => void) | undefined;
  /** Where this agent sits in a best-of run that is still being compared. */
  run?: RunPosition | undefined;
  /** Best-of runs started from this chat: how many finished, and a way to compare them. */
  runsCard?: { done: number; count: number; onCompare(): void } | undefined;
  onStartRuns?: ((request: StartRunsRequest) => Promise<string | undefined>) | undefined;
  /** Starts another agent inside this tile's chat. */
  onBringIn?: ((request: GuestRequest) => Promise<{ threadId: string } | { error: string }>) | undefined;
  /** Lets an agent that worked on its own copy go, with its worktree and branch. */
  onDiscardGuest?: ((threadId: string) => Promise<void>) | undefined;
  /** Shows another agent's own tile, found by its thread or terminal id. */
  onOpenAgent?: ((agentId: string) => void) | undefined;
  onBranch?: ((branch: { from: string; context: string }) => void) | undefined;
  onNewChatWithPrompt?: ((text: string) => void) | undefined;
  onAskAside?:
    | ((question: string, context: string | undefined) => Promise<{ threadId: string } | { error: string }>)
    | undefined;
  onCloseAside?: ((threadId: string) => void) | undefined;
  /** Shown only when the agent runs under a saved account rather than the usual login. */
  accountLabel?: string | undefined;
  /**
   * Opens a separate chat on this branch whose first message carries the end of this one. Absent where a
   * chat cannot start, such as a worktree still being set up.
   */
  onNewChat?: (() => Promise<string | undefined>) | undefined;
  /** The current chat has messages a new chat can bring along. */
  canCarryContext?: boolean | undefined;
  /** Shows one of this session's earlier chats in the tile. */
  onOpenChat?: ((threadId: string) => void) | undefined;
  /** Spans two grid rows to fill the space a short last row leaves. */
  tall?: boolean | undefined;
  /** Opens the dialog that names or renames a terminal agent. Absent until the agent has started. */
  onRename?: (() => void) | undefined;
  /** The agent that started this one, for a sub-agent whose starter is still around. */
  startedBy?: { label: string; onOpen(): void } | undefined;
  /** Opens a local address the chat runs, in the browser panel. */
  onOpenUrl?: ((url: string) => void) | undefined;
}) {
  const { bridge, dispatch } = useRuntime();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [cardHost, setCardHost] = useState<HTMLDivElement | null>(null);
  // The computer column sits beside the chat and shows unless the person closed it, the right panel open or not.
  // A tile too narrow for both opens it over the chat instead, only when asked, so a busy board is not covered.
  const [tileElement, setTileElement] = useState<HTMLElement | null>(null);
  const narrowTile = useNarrowTile(tileElement, COMPUTER_OVERLAY_WIDTH);
  const columnShown = useComputerColumnShown();
  const [overlayOpen, setOverlayOpen] = useState(false);
  const envCardOpen = narrowTile ? overlayOpen : columnShown;
  const setEnvCardOpen = (open: boolean) => (narrowTile ? setOverlayOpen(open) : setComputerColumnShown(open));
  useEffect(() => {
    if (!narrowTile) setOverlayOpen(false);
  }, [narrowTile]);
  // Over the chat, Escape inside the column puts it away.
  useEffect(() => {
    if (!narrowTile || !overlayOpen || !cardHost) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (!(event.target instanceof Node) || !cardHost.contains(event.target)) return;
      event.preventDefault();
      setOverlayOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [narrowTile, overlayOpen, cardHost]);
  const displayName = providerDisplayName(session.provider, projection.providers);
  useChatTitlesVersion();
  const title = sessionTitle(session, projection.messages, projection.providers);
  const chatKey = session.thread ? (session.thread.sessionId ?? session.thread.threadId) : undefined;
  const [editingTitle, setEditingTitle] = useState(false);
  const [headerMenu, setHeaderMenu] = useState<MenuRequest>();
  const agentName = sessionAgentName(session);
  const branch = worktree?.branch ?? "worktree";
  const terminal = session.terminal;
  const thread = session.thread;
  const mode = session.mode;
  const terminalLive = terminal?.status === "running" || terminal?.status === "starting";
  const fileLinks = useFileLinks(mode === "terminal" ? worktree?.worktreeId : undefined);
  const setup = worktree?.status === "bootstrapping" ? worktreeSetup(projection, worktree.worktreeId) : undefined;
  const review = projection.reviews?.find((candidate) => candidate.worktreeId === worktree?.worktreeId);
  const noGit = projection.projects.some(
    (project) => project.projectId === worktree?.projectId && project.git === false,
  );

  const send = useCallback(
    async (command: Record<string, unknown>): Promise<RpcResponse | undefined> => {
      try {
        const response = await dispatch({ protocolVersion: 1, commandId: makeCommandId(), command });
        if (response?.accepted === false) setError(response.error.message);
        return response;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "The command failed.");
        return undefined;
      }
    },
    [dispatch],
  );

  const start = async (next: SessionMode) => {
    setBusy(true);
    setError(undefined);
    const failure = await onStart(next);
    if (failure) setError(failure);
    setBusy(false);
  };

  const canStartChat = mode === "chat" && thread !== undefined && onNewChat !== undefined;
  const newChat = async () => {
    if (!onNewChat) return;
    setError(undefined);
    const failure = await onNewChat();
    if (failure) setError(failure);
  };
  const chats = mode === "chat" ? sessionChats(session, projection.messages, projection.providers) : [];
  // Shown only once the chat has messages to bring along.
  const newChatItems: MenuEntry[] = canCarryContext
    ? [
        {
          id: "context",
          label: "Continue in new chat",
          icon: "message",
          detail: "A new chat that starts with the end of this one",
          run: () => void newChat(),
        },
      ]
    : [];
  const historyItems: MenuEntry[] = chats.map((chat) => ({
    id: chat.threadId,
    label: chat.title,
    detail: chatDetail(chat),
    checked: chat.current,
    run: () => {
      if (!chat.current) onOpenChat?.(chat.threadId);
    },
  }));

  const canStop = sessionStopCommands(session).length > 0;
  const status = session.status;
  const statusBusy = status === "working" || status === "starting" || status === "preparing";
  const mark = <ProviderMark provider={session.provider} size={18} />;
  // The header keeps only the title, the environment, and one menu, so the chat list, the starter, and the
  // board controls all live in that menu. Each run is joined by a rule.
  const chatEntries: MenuEntry[] = canStartChat ? newChatItems : [];
  const historyEntries: MenuEntry[] = onOpenChat && chats.length > 1 ? historyItems : [];
  const placeEntries: MenuEntry[] = [
    ...(startedBy
      ? [
          {
            id: "started-by",
            label: `Show ${startedBy.label}`,
            icon: "bot" as const,
            detail: "Started this agent",
            run: startedBy.onOpen,
          },
        ]
      : []),
  ];
  const boardEntries: MenuEntry[] = canMaximize
    ? [
        {
          id: "maximize",
          label: maximized ? "Show all agents" : "Maximize",
          icon: maximized ? ("minimize" as const) : ("maximize" as const),
          run: onToggleMaximize,
        },
      ]
    : [];
  const tileItems: MenuEntry[] = [
    ...(mode === "chat" && chatKey
      ? [
          ...(customChatTitle(chatKey)
            ? [
                {
                  id: "auto-title",
                  label: "Title from first message",
                  icon: "reload" as const,
                  title: "Go back to the title the chat's first message gives it",
                  run: () => setChatTitle(chatKey, ""),
                },
              ]
            : []),
        ]
      : []),
    ...(onRename && mode !== "chat"
      ? [
          agentName
            ? {
                id: "rename",
                label: "Rename agent",
                icon: "pencil" as const,
                detail: agentName,
                run: onRename,
              }
            : {
                id: "rename",
                label: "Name this agent",
                icon: "pencil" as const,
                title: "Name this agent so you and other agents can refer to it",
                run: onRename,
              },
        ]
      : []),
  ];
  const moreItems: MenuEntry[] = [chatEntries, historyEntries, tileItems, placeEntries, boardEntries]
    .filter((group) => group.length > 0)
    .flatMap((group, index) => (index === 0 ? group : ["separator" as const, ...group]));
  const failed = status === "failed";
  // Who the agent is and which account it runs under stay one hover away instead of taking header room.
  const titleHint = [title, agentName, accountLabel ? `Account: ${accountLabel}` : undefined]
    .filter(Boolean)
    .join("\n");

  return (
    <section
      ref={setTileElement}
      className={`agent-tile${active ? " is-active" : ""}${tall ? " is-tall" : ""}`}
      data-session-id={session.sessionId}
      aria-label={agentName ? `${agentName}, ${title}, ${displayName}` : `${title}, ${displayName}`}
      onFocusCapture={onFocus}
      onMouseDown={onFocus}
    >
      {mode === "chat" ? <ChatBackdrop /> : null}
      {/* The tile's other actions (continue in a new chat, earlier chats, maximize) open on a right-click here,
          so the header keeps only the title and its two buttons. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a right-click shortcut; the same actions are in the command palette and have keyboard shortcuts. */}
      <header
        className="tile-header"
        onContextMenu={(event) => {
          if (moreItems.length === 0 || (event.target as HTMLElement).closest("input, textarea")) return;
          event.preventDefault();
          const bar = event.currentTarget.getBoundingClientRect();
          const fromKeyboard = event.clientX === 0 && event.clientY === 0;
          setHeaderMenu({
            x: fromKeyboard ? bar.left : event.clientX,
            y: fromKeyboard ? bar.bottom : event.clientY,
            label: "Chat actions",
            items: menuItemsOf(moreItems),
          });
        }}
      >
        {/* A chat's tile shows the conversation, not the agent: the agent can change under it, and the
            message box already says which one answers. */}
        <span className="tile-mark" aria-hidden="true">
          {mode === "chat" ? <Icon name="message" size={13} /> : <ProviderMark provider={session.provider} size={13} />}
        </span>
        {mode === "chat" && chatKey && editingTitle ? (
          <ChatTitleEditor
            title={title}
            onDone={(next) => {
              setEditingTitle(false);
              if (next !== undefined && next !== title) setChatTitle(chatKey, next);
            }}
          />
        ) : mode === "chat" && chatKey ? (
          <button
            type="button"
            className="tile-title is-editable"
            title={`${titleHint}\nDouble-click to rename`}
            aria-label={`Rename chat: ${title}`}
            onDoubleClick={() => setEditingTitle(true)}
          >
            {title}
          </button>
        ) : (
          <span className="tile-title" title={titleHint}>
            {title}
          </span>
        )}
        {/* The chat, the sidebar, and the agent's own terminal already say how it is doing. Only a failure
            earns a mark here, so a tile that stopped working stands out on a busy board. */}
        {failed ? (
          <span
            className="tile-failed"
            role="img"
            aria-label={sessionStatusLabel.failed}
            title={sessionStatusLabel.failed}
          >
            <Icon name="alert" size={12} />
          </span>
        ) : null}
        {/* A chat's message box already shows its folder and branch, so the header does not repeat them. */}
        {mode === "chat" ? null : (
          <span className="tile-branch" title={worktree?.path}>
            {branch}
          </span>
        )}
        {run ? (
          <span className="tile-run" title={`Run ${run.index} of ${run.count} for ${run.group.label}`}>
            Run {run.index}
          </span>
        ) : null}
        <span className="tile-spacer" />
        <span className="tile-actions">
          {worktree?.status === "ready" ? (
            <EnvironmentButton
              worktree={worktree}
              review={review}
              noGit={noGit}
              onOpenChanges={() => onOpenDiff()}
              onOpenPullRequest={onOpenPullRequest}
              onOpenUrl={onOpenUrl}
              card={
                mode === "chat"
                  ? {
                      open: envCardOpen,
                      host: cardHost,
                      overlay: narrowTile,
                      onOpenChange: setEnvCardOpen,
                      session,
                      project: projection.projects.find((entry) => entry.projectId === worktree.projectId),
                      accountName: accountLabel,
                    }
                  : undefined
              }
            />
          ) : null}

          {canStop && mode !== "chat" ? (
            <StopButton
              className="tile-stop"
              size="xs"
              working={statusBusy}
              label="Stop agent"
              tooltip="Stop the agent in the terminal and the chat"
              onClick={() => {
                setError(undefined);
                onStop();
              }}
            >
              Stop
            </StopButton>
          ) : null}
          {closable ? <IconButton label="Close tile" icon="x" size="sm" iconSize={14} onClick={onClose} /> : null}
        </span>
      </header>
      {headerMenu ? <Menu request={headerMenu} onClose={() => setHeaderMenu(undefined)} /> : null}
      <div className="tile-body">
        <div className="tile-main">
          {!terminal && !thread && session.pending ? (
            session.pending.errorMessage ? (
              <EmptyState
                icon="alert"
                tone="danger"
                title={`${displayName} could not start`}
                detail={session.pending.errorMessage}
              >
                <Button icon="reload" onClick={onRetryPending}>
                  Try again
                </Button>
                <Button variant="ghost" onClick={onDismissPending}>
                  Dismiss
                </Button>
              </EmptyState>
            ) : setup ? (
              <EmptyState
                media={<span className="spinner" aria-hidden="true" />}
                title={`Setting up ${branch}`}
                detail={`${displayName} starts when setup finishes. ${setupProgress(setup)}`}
              >
                {setup.status === "waiting" ? (
                  <Button variant="primary" icon="check" onClick={onReviewSetup}>
                    Review setup
                  </Button>
                ) : null}
                {setup.terminalId ? (
                  <Button icon="terminal" onClick={onShowSetupOutput}>
                    Show output
                  </Button>
                ) : null}
              </EmptyState>
            ) : session.pending.mode === "chat" &&
              session.pending.draft &&
              worktree?.status === "ready" &&
              onDraftChange &&
              onDraftMove &&
              onDraftSend ? (
              <DraftChat
                projection={projection}
                launch={session.pending}
                worktree={worktree}
                active={active}
                onChange={onDraftChange}
                onMove={onDraftMove}
                onAddFolder={onAddFolder}
                onSend={onDraftSend}
              />
            ) : session.pending.mode === "chat" && worktree?.status === "ready" ? (
              // The chat opens at once; the agent starts behind it.
              <div className="tile-chat-start">
                <ChatStart
                  provider={session.provider}
                  folder={projection.projects.find((project) => project.projectId === worktree.projectId)?.name}
                />
              </div>
            ) : (
              <EmptyState
                media={<span className="spinner" aria-hidden="true" />}
                title={`Preparing ${branch}`}
                detail={`${displayName} starts as soon as the worktree is ready${worktree ? ` (${worktree.status})` : ""}.`}
              />
            )
          ) : mode === "terminal" ? (
            terminal && bridge ? (
              <div className="tile-terminal">
                <LazyTerminalView
                  key={terminal.terminalId}
                  bridge={bridge}
                  terminalId={terminal.terminalId}
                  running={terminal.status === "running"}
                  send={send}
                  label={`${displayName} terminal`}
                  className="agent-terminal-output"
                  autoFocus={active}
                  onFocus={onFocus}
                  fileLinks={fileLinks}
                />
                {!terminalLive ? (
                  <div className={`tile-ended${terminal.status === "failed" ? " is-failed" : ""}`} role="status">
                    <Icon name={terminal.status === "failed" ? "alert" : "square"} size={12} />
                    <span className="tile-ended-message">
                      {terminal.status === "failed"
                        ? (terminal.errorMessage ?? `${displayName} failed to start.`)
                        : `${displayName} exited.`}
                    </span>
                    <Button size="sm" icon="reload" loading={busy} onClick={() => void start("terminal")}>
                      Restart
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : (
              <EmptyState
                media={mark}
                title={`Run ${displayName} in a terminal`}
                detail={`Starts the ${displayName} CLI in ${branch}.`}
              >
                <Button variant="primary" icon="play" loading={busy} onClick={() => void start("terminal")}>
                  {busy ? "Starting" : "Start in terminal"}
                </Button>
              </EmptyState>
            )
          ) : thread ? (
            <>
              {runsCard ? <RunsCard {...runsCard} /> : null}
              <ChatView
                key={thread.threadId}
                projection={projection}
                thread={thread}
                worktree={worktree}
                onOpenDiff={onOpenDiff}
                onRestart={() => void start("chat")}
                onSwitchAgent={onSwitchAgent}
                onMoveChat={onMoveChat}
                onAddFolder={onAddFolder}
                onOpenConnectors={onOpenConnectors}
                onStartRuns={onStartRuns}
                onBringIn={onBringIn}
                onDiscardGuest={onDiscardGuest}
                onOpenAgent={onOpenAgent}
                onBranch={onBranch}
                onNewChatWithPrompt={onNewChatWithPrompt}
                onAskAside={onAskAside}
                onCloseAside={onCloseAside}
                active={active}
              />
            </>
          ) : (
            <EmptyState
              media={mark}
              title={`Chat with ${displayName}`}
              detail={`A chat with a work log and diffs, in ${branch}.`}
            >
              <Button variant="primary" icon="message" loading={busy} onClick={() => void start("chat")}>
                {busy ? "Starting" : "Start chat"}
              </Button>
            </EmptyState>
          )}
          {error ? (
            <p className="inline-error tile-error" role="alert">
              <Icon name="alert" size={13} />
              <span>{error}</span>
            </p>
          ) : null}
        </div>
        {mode === "chat" ? (
          <div className={`env-card-host${narrowTile ? " is-overlay" : ""}`} ref={setCardHost} />
        ) : null}
      </div>
    </section>
  );
}

/** The chat's title as a field, for renaming it in place. Enter keeps the name, Escape keeps the old one. */
function ChatTitleEditor({ title, onDone }: { title: string; onDone(title: string | undefined): void }) {
  const [value, setValue] = useState(title);
  const done = useRef(false);
  const finish = (next: string | undefined) => {
    if (done.current) return;
    done.current = true;
    onDone(next);
  };
  return (
    <input
      className="tile-title-input"
      aria-label="Chat title"
      // biome-ignore lint/a11y/noAutofocus: the field opens because the person clicked the title to rename it.
      autoFocus
      value={value}
      maxLength={120}
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          finish(value);
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          finish(undefined);
        }
      }}
      onBlur={() => finish(value)}
    />
  );
}

/** True while the element is narrower than `width`. Without ResizeObserver the tile counts as wide. */
function useNarrowTile(element: HTMLElement | null, width: number): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (!element || typeof ResizeObserver === "undefined") return;
    const measure = () => setNarrow(element.getBoundingClientRect().width < width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, width]);
  return narrow;
}
/** The header's actions as a right-click menu: the same items, with the separators between their runs. */
function menuItemsOf(entries: readonly MenuEntry[]): MenuItem[] {
  return entries.map((entry) =>
    entry === "separator"
      ? { separator: true as const }
      : {
          id: entry.id,
          label: entry.label,
          icon: entry.icon,
          disabled: entry.disabled,
          checked: entry.checked,
          title: entry.title ?? entry.detail,
          shortcut: entry.shortcut,
          run: entry.run,
        },
  );
}
