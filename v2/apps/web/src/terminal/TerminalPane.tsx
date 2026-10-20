import type { RpcResponse, RuntimeProjection, TerminalProjection, WorktreeProjection } from "@zli-v2/contracts";
import { useCallback, useState } from "react";
import { makeCommandId } from "../runtime/commandId.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";
import { Icon } from "../ui/Icon.js";
import { EmptyState, PaneHeader } from "../ui/Pane.js";
import { TerminalView } from "./TerminalView.js";

type Props = {
  projection: RuntimeProjection | undefined;
  worktree: WorktreeProjection | undefined;
  onOpenBrowser(): void;
};

export function TerminalPane({ projection, worktree, onOpenBrowser }: Props) {
  const { bridge, dispatch } = useRuntime();
  const terminals = (projection?.terminals ?? []).filter((candidate) => candidate.worktreeId === worktree?.worktreeId);
  const [selectedId, setSelectedId] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const terminal = terminals.find((candidate) => candidate.terminalId === selectedId) ?? preferredTerminal(terminals);

  const send = useCallback(
    async (command: Record<string, unknown>): Promise<RpcResponse | undefined> => {
      try {
        const response = await dispatch({ protocolVersion: 1, commandId: makeCommandId(), command });
        if (response?.accepted === false) setError(response.error.message);
        return response;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "The terminal command failed.");
        return undefined;
      }
    },
    [dispatch],
  );

  const createTerminal = async () => {
    if (!worktree) return;
    setBusy(true);
    setError(undefined);
    const terminalId = makeCommandId();
    const response = await send({
      type: "terminal.create",
      terminalId,
      worktreeId: worktree.worktreeId,
      cwd: worktree.path,
      shell: shellForPlatform(),
      title: `Terminal ${terminals.length + 1}`,
      cols: 120,
      rows: 32,
    });
    if (response?.accepted) setSelectedId(terminalId);
    setBusy(false);
  };

  const stopTerminal = async (terminalId: string) => {
    setError(undefined);
    await send({ type: "terminal.stop", terminalId });
  };

  const live = terminal?.status === "running" || terminal?.status === "starting";

  return (
    <div className="tool-pane terminal-pane">
      <PaneHeader icon="terminal" title="Terminal" detail={worktree?.branch}>
        {terminal ? (
          <span className={`pane-status status-text-${terminal.status}`}>
            <span className={`terminal-tab-dot terminal-tab-dot-${terminal.status}`} aria-hidden="true" />
            {terminal.status}
          </span>
        ) : null}
      </PaneHeader>
      {!worktree ? (
        <EmptyState
          icon="terminal"
          title="Select a worktree"
          detail="Terminal sessions belong to a worktree, so there is nothing to attach yet."
        />
      ) : terminal ? (
        <>
          <div className="terminal-tabs">
            <div className="terminal-tab-list" role="tablist" aria-label="Terminal sessions">
              {terminals.map((candidate) => (
                <button
                  key={candidate.terminalId}
                  type="button"
                  role="tab"
                  className="terminal-tab"
                  aria-selected={candidate.terminalId === terminal.terminalId}
                  title={`${candidate.title} (${candidate.status})`}
                  onClick={() => setSelectedId(candidate.terminalId)}
                >
                  <span className={`terminal-tab-dot terminal-tab-dot-${candidate.status}`} aria-hidden="true" />
                  <span className="terminal-tab-title">{candidate.title}</span>
                </button>
              ))}
            </div>
            <div className="terminal-tab-actions">
              {live && (
                <button
                  className="ghost-button"
                  type="button"
                  onClick={() => void stopTerminal(terminal.terminalId)}
                  disabled={terminal.status !== "running"}
                >
                  <Icon name="square" size={12} />
                  Stop
                </button>
              )}
              <button className="ghost-button" type="button" onClick={() => void createTerminal()} disabled={busy}>
                <Icon name="plus" size={13} />
                {busy ? "Starting" : "New terminal"}
              </button>
            </div>
          </div>
          {bridge && (
            <TerminalView
              key={terminal.terminalId}
              bridge={bridge}
              terminalId={terminal.terminalId}
              running={terminal.status === "running"}
              send={send}
            />
          )}
          {!live && (
            <div className="terminal-exited" role="status">
              <span>
                {terminal.status === "failed" ? "This terminal failed to start." : "This terminal session has ended."}
              </span>
              <button className="primary-button" type="button" onClick={() => void createTerminal()} disabled={busy}>
                {busy ? "Starting" : "Start new terminal"}
              </button>
            </div>
          )}
          {terminal.errorMessage && (
            <p className="inline-error" role="alert">
              {terminal.errorMessage}
            </p>
          )}
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
        </>
      ) : (
        <EmptyState
          icon="terminal"
          title="No terminal session"
          detail={`A shell that opens in ${worktree.branch}, separate from the agent.`}
        >
          <div className="empty-actions">
            <button className="primary-button" type="button" onClick={() => void createTerminal()} disabled={busy}>
              {busy ? "Starting" : "Start terminal"}
            </button>
            <button className="secondary-button" type="button" onClick={onOpenBrowser}>
              Open browser
            </button>
          </div>
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
        </EmptyState>
      )}
    </div>
  );
}

function preferredTerminal(terminals: TerminalProjection[]): TerminalProjection | undefined {
  return (
    terminals.findLast((candidate) => candidate.status === "running" || candidate.status === "starting") ??
    terminals.at(-1)
  );
}

function shellForPlatform(): string {
  return navigator.userAgent.includes("Windows") ? "powershell.exe" : "/bin/bash";
}
