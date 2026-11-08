import { huddlesOf, type RpcResponse, type RuntimeProjection, type WorktreeProjection } from "@zli-v2/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { providerDisplayName } from "../agent/providers.js";
import { ChatView, type StartRunsRequest } from "../chat/ChatView.js";
import { useFileLinks } from "../files/FileIndex.js";
import { HUDDLE_AGENT_DRAG_TYPE, sessionAgentId, typingHeldCount } from "../huddle/huddles.js";
import { HuddleHeldPill, HuddleMenuButton, TileHuddleChip } from "../huddle/TileHuddle.js";
import { makeCommandId } from "../runtime/commandId.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";
import { setupProgress, worktreeSetup } from "../setup/setup.js";
import { LazyTerminalView } from "../terminal/LazyTerminalView.js";
import { Badge, type BadgeTone } from "../ui/Badge.js";
import { Button, IconButton } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { MenuButton, type MenuEntry } from "../ui/Menu.js";
import { EmptyState } from "../ui/Pane.js";
import { ProviderMark } from "../ui/ProviderMark.js";
import { StopButton } from "../ui/StopButton.js";
import type { RunPosition } from "./bestOf.js";
import { EnvironmentButton } from "./EnvironmentButton.js";
import {
  type AgentSession,
  chatStatusLabel,
  relativeTime,
  type SessionChat,
  type SessionMode,
  type SessionStatus,
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

const statusTone: Record<SessionStatus, BadgeTone> = {
  preparing: "info",
  starting: "info",
  working: "info",
  waiting: "warning",
  ready: "success",
  ended: "quiet",
  failed: "danger",
};

export function AgentTile({
  projection,
  session,
  worktree,
  active,
  maximized,
  canMaximize,
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
  onHandoff,
  onOpenConnectors,
  run,
  onStartRuns,
  accountLabel,
  onNewChat,
  canCarryContext = false,
  newChatRequest,
  newChatShortcut,
  onOpenChat,
  tall = false,
  onRename,
  startedBy,
  onOpenHuddle,
}: {
  projection: RuntimeProjection;
  session: AgentSession;
  worktree: WorktreeProjection | undefined;
  active: boolean;
  maximized: boolean;
  canMaximize: boolean;
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
  /** Absent when the chat has nothing to hand over yet. */
  onHandoff?: (() => void) | undefined;
  /** Opens Settings at a connector, for a chat that needs one. */
  onOpenConnectors?: ((connectorId?: string) => void) | undefined;
  /** Where this agent sits in a best-of run that is still being compared. */
  run?: RunPosition | undefined;
  onStartRuns?: ((request: StartRunsRequest) => Promise<string | undefined>) | undefined;
  /** Shown only when the agent runs under a saved account rather than the usual login. */
  accountLabel?: string | undefined;
  /** Starts another chat in this tile. Absent where a chat cannot start, such as a worktree still being set up. */
  onNewChat?: ((withContext: boolean) => Promise<string | undefined>) | undefined;
  /** The current chat has messages a new chat can bring along. */
  canCarryContext?: boolean | undefined;
  /** Changes when the New chat shortcut asks this tile to open its menu. */
  newChatRequest?: number | undefined;
  newChatShortcut?: string | undefined;
  /** Shows one of this session's earlier chats in the tile. */
  onOpenChat?: ((threadId: string) => void) | undefined;
  /** Spans two grid rows to fill the space a short last row leaves. */
  tall?: boolean | undefined;
  /** Opens the dialog that names or renames the agent. Absent until the agent has started. */
  onRename?: (() => void) | undefined;
  /** The agent that started this one, for a sub-agent whose starter is still around. */
  startedBy?: { label: string; onOpen(): void } | undefined;
  /** Opens the Huddle panel on a huddle. Without it the tile shows no huddle controls. */
  onOpenHuddle?: ((huddleId: string) => void) | undefined;
}) {
  const { bridge, dispatch } = useRuntime();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const displayName = providerDisplayName(session.provider, projection.providers);
  const title = sessionTitle(session, projection.messages, projection.providers);
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

  const newChatButton = useRef<HTMLButtonElement>(null);
  const seenRequest = useRef(newChatRequest);
  useEffect(() => {
    if (newChatRequest === seenRequest.current) return;
    seenRequest.current = newChatRequest;
    newChatButton.current?.click();
  }, [newChatRequest]);
  const newChat = async (withContext: boolean) => {
    if (!onNewChat) return;
    setError(undefined);
    const failure = await onNewChat(withContext);
    if (failure) setError(failure);
  };
  const chats = mode === "chat" ? sessionChats(session, projection.messages, projection.providers) : [];
  const newChatItems: MenuEntry[] = [
    {
      id: "blank",
      label: "Blank chat",
      icon: "squarePen",
      detail: "Starts with no earlier messages",
      run: () => void newChat(false),
    },
    {
      id: "context",
      label: "Start with recent context",
      icon: "message",
      detail: canCarryContext ? "Brings the end of this chat along" : "This chat has no messages to bring yet",
      disabled: !canCarryContext,
      run: () => void newChat(true),
    },
  ];
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
  const huddleAgentId = onOpenHuddle ? sessionAgentId(session) : undefined;
  const memberOf = huddleAgentId ? huddlesOf(projection, huddleAgentId) : [];
  const heldForTyping = huddleAgentId && mode === "terminal" ? typingHeldCount(projection, huddleAgentId) : 0;

  return (
    <section
      className={`agent-tile${active ? " is-active" : ""}${tall ? " is-tall" : ""}`}
      data-session-id={session.sessionId}
      aria-label={agentName ? `${agentName}, ${title}, ${displayName}` : `${title}, ${displayName}`}
      onFocusCapture={onFocus}
      onMouseDown={onFocus}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: dragging the header onto the Huddle panel is a mouse shortcut; the Add to huddle menu does the same from the keyboard. */}
      <header
        className="tile-header"
        draggable={huddleAgentId ? true : undefined}
        onDragStart={
          huddleAgentId
            ? (event) => {
                event.dataTransfer.setData(HUDDLE_AGENT_DRAG_TYPE, huddleAgentId);
                event.dataTransfer.setData("text/plain", agentName ?? title);
                event.dataTransfer.effectAllowed = "copy";
              }
            : undefined
        }
      >
        <span className="tile-mark" aria-hidden="true">
          <ProviderMark provider={session.provider} size={13} />
        </span>
        {agentName ? (
          onRename ? (
            <button
              type="button"
              className="tile-name"
              title={`${agentName}. Click to rename`}
              aria-label={`Rename ${agentName}`}
              onClick={onRename}
            >
              {agentName}
            </button>
          ) : (
            <span className="tile-name" title={agentName}>
              {agentName}
            </span>
          )
        ) : null}
        {startedBy ? (
          <button
            type="button"
            className="tile-parent"
            title={`Started by ${startedBy.label}. Click to show it`}
            aria-label={`Sub-agent of ${startedBy.label}. Show ${startedBy.label}`}
            onClick={startedBy.onOpen}
          >
            Sub-agent of {startedBy.label}
          </button>
        ) : null}
        {onOpenHuddle ? <TileHuddleChip huddles={memberOf} onOpen={onOpenHuddle} /> : null}
        <span className="tile-title" title={title}>
          {title}
        </span>
        <span className="tile-branch" title={worktree?.path}>
          <Icon name="branch" size={11} />
          <span>{branch}</span>
        </span>
        {accountLabel ? (
          <span className="tile-account" title={`Account: ${accountLabel}`}>
            <Icon name="user" size={11} />
            <span>{accountLabel}</span>
          </span>
        ) : null}
        {run ? (
          <span className="tile-run" title={`Run ${run.index} of ${run.count} for ${run.group.label}`}>
            Run {run.index}
          </span>
        ) : null}
        <Badge
          className="tile-status"
          tone={statusTone[status]}
          dot={!statusBusy}
          spinner={statusBusy}
          title={sessionStatusLabel[status]}
        >
          {sessionStatusLabel[status]}
        </Badge>
        <span className="tile-spacer" />
        <span className="tile-actions">
          {worktree?.status === "ready" ? (
            <EnvironmentButton worktree={worktree} review={review} noGit={noGit} onOpenChanges={() => onOpenDiff()} />
          ) : null}
          {onOpenChat && chats.length > 1 ? (
            <MenuButton
              label="Chat history"
              tooltip={`Chat history: ${chats.length} chats`}
              icon="history"
              size="sm"
              iconSize={13}
              items={historyItems}
            />
          ) : null}
          {mode === "chat" && thread && onNewChat ? (
            <MenuButton
              ref={newChatButton}
              label="New chat"
              tooltip="New chat. This one stays in history"
              shortcut={newChatShortcut}
              icon="squarePen"
              size="sm"
              iconSize={13}
              items={newChatItems}
            />
          ) : null}
          {huddleAgentId && onOpenHuddle ? (
            <HuddleMenuButton
              projection={projection}
              agentId={huddleAgentId}
              agentLabel={agentName ?? title}
              onOpen={onOpenHuddle}
              onError={setError}
            />
          ) : null}
          {mode === "chat" && onHandoff ? (
            <IconButton
              label="Continue with another agent"
              tooltip="Continue this chat with another agent"
              icon="handoff"
              size="sm"
              iconSize={13}
              onClick={onHandoff}
            />
          ) : null}
          {onRename && !agentName ? (
            <IconButton
              label="Name this agent"
              tooltip="Name this agent so you and other agents can refer to it"
              icon="pencil"
              size="sm"
              iconSize={13}
              onClick={onRename}
            />
          ) : null}
          {canStop ? (
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
          {canMaximize ? (
            <IconButton
              label={maximized ? "Show all agents" : "Maximize"}
              icon={maximized ? "minimize" : "maximize"}
              size="sm"
              onClick={onToggleMaximize}
            />
          ) : null}
          <IconButton label="Close tile" icon="x" size="sm" iconSize={14} onClick={onClose} />
        </span>
      </header>
      <div className="tile-body">
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
              {huddleAgentId && terminalLive ? (
                <HuddleHeldPill count={heldForTyping} agentId={huddleAgentId} onError={setError} />
              ) : null}
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
          <ChatView
            key={thread.threadId}
            projection={projection}
            thread={thread}
            worktree={worktree}
            onOpenDiff={onOpenDiff}
            onRestart={() => void start("chat")}
            onHandoff={onHandoff}
            onOpenConnectors={onOpenConnectors}
            onStartRuns={onStartRuns}
            active={active}
          />
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
    </section>
  );
}
