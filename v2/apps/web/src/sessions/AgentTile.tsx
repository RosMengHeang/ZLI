import type { RpcResponse, RuntimeProjection, WorktreeProjection } from "@zli-v2/contracts";
import { useCallback, useState } from "react";

import { providerDisplayName } from "../agent/providers.js";
import { ChatView } from "../chat/ChatView.js";
import { makeCommandId } from "../runtime/commandId.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";
import { TerminalView } from "../terminal/TerminalView.js";
import { Icon } from "../ui/Icon.js";
import { ProviderMark } from "../ui/ProviderMark.js";
import {
  type AgentSession,
  type SessionMode,
  sessionStatusLabel,
  sessionStopCommands,
  sessionTitle,
} from "./sessions.js";

export function AgentTile({
  projection,
  session,
  worktree,
  mode,
  active,
  maximized,
  canMaximize,
  onModeChange,
  onFocus,
  onToggleMaximize,
  onStop,
  onClose,
  onOpenDiff,
  onStart,
  onRetryPending,
  onDismissPending,
}: {
  projection: RuntimeProjection;
  session: AgentSession;
  worktree: WorktreeProjection | undefined;
  mode: SessionMode;
  active: boolean;
  maximized: boolean;
  canMaximize: boolean;
  onModeChange(mode: SessionMode): void;
  onFocus(): void;
  onToggleMaximize(): void;
  onStop(): void;
  onClose(): void;
  onOpenDiff(path?: string): void;
  onStart(mode: SessionMode): Promise<string | undefined>;
  onRetryPending(): void;
  onDismissPending(): void;
}) {
  const { bridge, dispatch } = useRuntime();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const displayName = providerDisplayName(session.provider, projection.providers);
  const title = sessionTitle(session, projection.messages, projection.providers);
  const branch = worktree?.branch ?? "worktree";
  const terminal = session.terminal;
  const thread = session.thread;
  const terminalLive = terminal?.status === "running" || terminal?.status === "starting";

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

  const interrupt = () => {
    if (!thread) return;
    void send({
      type: "thread.interrupt",
      threadId: thread.threadId,
      ...(thread.activeTurnId ? { turnId: thread.activeTurnId } : {}),
    });
  };

  const canStop = sessionStopCommands(session).length > 0;

  return (
    <section
      className={`agent-tile${active ? " is-active" : ""}`}
      aria-label={`${title}, ${displayName}`}
      onFocusCapture={onFocus}
      onMouseDown={onFocus}
    >
      <header className="tile-header">
        <ProviderMark provider={session.provider} size={15} />
        <span className="tile-title" title={title}>
          {title}
        </span>
        <span className="tile-branch" title={worktree?.path}>
          <Icon name="branch" size={11} />
          <span>{branch}</span>
        </span>
        <span className={`status-pill is-${session.status}`} title={sessionStatusLabel[session.status]}>
          <span className="status-pill-dot" aria-hidden="true" />
          {sessionStatusLabel[session.status]}
        </span>
        <span className="tile-spacer" />
        {session.pending && !terminal && !thread ? null : (
          <div className="segmented">
            <button
              type="button"
              aria-pressed={mode === "terminal"}
              aria-label="Terminal view"
              title="Agent CLI in a terminal"
              onClick={() => onModeChange("terminal")}
            >
              <Icon name="terminal" size={12} />
              <span>Terminal</span>
            </button>
            <button
              type="button"
              aria-pressed={mode === "chat"}
              aria-label="Chat view"
              title="Chat with a work log"
              onClick={() => onModeChange("chat")}
            >
              <Icon name="message" size={12} />
              <span>Chat</span>
            </button>
          </div>
        )}
        <span className="tile-actions">
          {mode === "chat" && (thread?.status === "working" || thread?.status === "waiting") ? (
            <button
              className="icon-button"
              type="button"
              aria-label="Interrupt"
              title="Interrupt the turn"
              onClick={interrupt}
            >
              <Icon name="pause" size={13} />
            </button>
          ) : null}
          {canStop ? (
            <button
              className="icon-button"
              type="button"
              aria-label="Stop agent"
              title="Stop agent (terminal and chat)"
              onClick={() => {
                setError(undefined);
                onStop();
              }}
            >
              <Icon name="square" size={12} />
            </button>
          ) : null}
          {canMaximize ? (
            <button
              className="icon-button"
              type="button"
              aria-label={maximized ? "Show all agents" : "Maximize"}
              title={maximized ? "Show all agents" : "Maximize"}
              onClick={onToggleMaximize}
            >
              <Icon name={maximized ? "minimize" : "maximize"} size={13} />
            </button>
          ) : null}
          <button className="icon-button" type="button" aria-label="Close tile" title="Close tile" onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </span>
      </header>
      <div className="tile-body">
        {!terminal && !thread && session.pending ? (
          <div className="tile-empty">
            {session.pending.errorMessage ? (
              <>
                <p className="tile-empty-title">{displayName} could not start</p>
                <p className="tile-empty-detail">{session.pending.errorMessage}</p>
                <div className="tile-empty-actions">
                  <button className="secondary-button" type="button" onClick={onRetryPending}>
                    Try again
                  </button>
                  <button className="ghost-button" type="button" onClick={onDismissPending}>
                    Dismiss
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="tile-empty-title">Preparing {branch}</p>
                <p className="tile-empty-detail">
                  {displayName} starts as soon as the worktree is ready{worktree ? ` (${worktree.status})` : ""}.
                </p>
              </>
            )}
          </div>
        ) : mode === "terminal" ? (
          terminal && bridge ? (
            <div className="tile-terminal">
              <TerminalView
                key={terminal.terminalId}
                bridge={bridge}
                terminalId={terminal.terminalId}
                running={terminal.status === "running"}
                send={send}
                label={`${displayName} terminal`}
                className="agent-terminal-output"
                autoFocus={active}
                onFocus={onFocus}
              />
              {!terminalLive ? (
                <div className="tile-ended" role="status">
                  <span>
                    {terminal.status === "failed"
                      ? (terminal.errorMessage ?? `${displayName} failed to start.`)
                      : `${displayName} exited.`}
                  </span>
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={busy}
                    onClick={() => void start("terminal")}
                  >
                    <Icon name="reload" size={12} />
                    Restart
                  </button>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="tile-empty">
              <ProviderMark provider={session.provider} size={22} />
              <p className="tile-empty-title">Run {displayName} in a terminal</p>
              <p className="tile-empty-detail">
                Starts the {displayName} CLI in {branch}. It keeps its own history, separate from the chat.
              </p>
              <div className="tile-empty-actions">
                <button className="primary-button" type="button" disabled={busy} onClick={() => void start("terminal")}>
                  {busy ? "Starting" : "Start in terminal"}
                </button>
              </div>
            </div>
          )
        ) : thread ? (
          <ChatView
            key={thread.threadId}
            projection={projection}
            thread={thread}
            worktree={worktree}
            onOpenDiff={onOpenDiff}
            onRestart={() => void start("chat")}
          />
        ) : (
          <div className="tile-empty">
            <ProviderMark provider={session.provider} size={22} />
            <p className="tile-empty-title">Chat with {displayName}</p>
            <p className="tile-empty-detail">
              A structured chat with a work log and diffs, in {branch}. It does not share history with the terminal.
            </p>
            <div className="tile-empty-actions">
              <button className="primary-button" type="button" disabled={busy} onClick={() => void start("chat")}>
                {busy ? "Starting" : "Start chat"}
              </button>
            </div>
          </div>
        )}
        {error ? (
          <p className="inline-error tile-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
