import { useCallback, useState } from "react";

import type { RpcResponse, RuntimeProjection, TerminalProjection, WorktreeProjection } from "@zli-v2/contracts";
import { useRuntime } from "../runtime/RuntimeProvider.js";
import { makeCommandId } from "../runtime/commandId.js";
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
      <div className="tool-pane-header">
        <div>
          <span className="eyebrow">Terminal</span>
          <h2>{worktree?.branch ?? "No worktree selected"}</h2>
        </div>
        <span className="pane-meta">{terminal ? terminal.status : "Idle"}</span>
      </div>
      {!worktree ? (
        <EmptyPane
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
                  className="secondary-button"
                  type="button"
                  onClick={() => void stopTerminal(terminal.terminalId)}
                  disabled={terminal.status !== "running"}
                >
                  Stop
                </button>
              )}
              <button className="secondary-button" type="button" onClick={() => void createTerminal()} disabled={busy}>
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
        <div className="empty-pane">
          <p className="empty-title">No terminal session</p>
          <p className="empty-detail">Start a real PTY attached to this worktree, or open the Chromium workspace.</p>
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
        </div>
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

function EmptyPane({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="empty-pane">
      <p className="empty-title">{title}</p>
      <p className="empty-detail">{detail}</p>
    </div>
  );
}

function shellForPlatform(): string {
  return navigator.userAgent.includes("Windows") ? "powershell.exe" : "/bin/bash";
}
