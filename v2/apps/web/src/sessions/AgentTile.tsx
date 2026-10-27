import type { RpcResponse, RuntimeProjection, WorktreeProjection } from "@zli-v2/contracts";
import { useCallback, useState } from "react";

import { providerDisplayName } from "../agent/providers.js";
import { ChatView, type StartRunsRequest } from "../chat/ChatView.js";
import { useFileLinks } from "../files/FileIndex.js";
import { makeCommandId } from "../runtime/commandId.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";
import { setupProgress, worktreeSetup } from "../setup/setup.js";
import { LazyTerminalView } from "../terminal/LazyTerminalView.js";
import { Badge, type BadgeTone } from "../ui/Badge.js";
import { Button, IconButton } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { EmptyState } from "../ui/Pane.js";
import { ProviderMark } from "../ui/ProviderMark.js";
import { StopButton } from "../ui/StopButton.js";
import type { RunPosition } from "./bestOf.js";
import {
  type AgentSession,
  type SessionMode,
  type SessionStatus,
  sessionStatusLabel,
  sessionStopCommands,
  sessionTitle,
} from "./sessions.js";

import "./tile.css";

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
}) {
  const { bridge, dispatch } = useRuntime();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const displayName = providerDisplayName(session.provider, projection.providers);
  const title = sessionTitle(session, projection.messages, projection.providers);
  const branch = worktree?.branch ?? "worktree";
  const terminal = session.terminal;
  const thread = session.thread;
  const mode = session.mode;
  const terminalLive = terminal?.status === "running" || terminal?.status === "starting";
  const fileLinks = useFileLinks(mode === "terminal" ? worktree?.worktreeId : undefined);
  const setup = worktree?.status === "bootstrapping" ? worktreeSetup(projection, worktree.worktreeId) : undefined;

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

  const canStop = sessionStopCommands(session).length > 0;
  const status = session.status;
  const statusBusy = status === "working" || status === "starting" || status === "preparing";
  const mark = <ProviderMark provider={session.provider} size={18} />;

  return (
    <section
      className={`agent-tile${active ? " is-active" : ""}`}
      data-session-id={session.sessionId}
      aria-label={`${title}, ${displayName}`}
      onFocusCapture={onFocus}
      onMouseDown={onFocus}
    >
      <header className="tile-header">
        <span className="tile-mark" aria-hidden="true">
          <ProviderMark provider={session.provider} size={13} />
        </span>
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
