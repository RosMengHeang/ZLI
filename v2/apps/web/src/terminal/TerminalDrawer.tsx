import type { RpcResponse, RuntimeProjection, TerminalProjection, WorktreeProjection } from "@zli-v2/contracts";
import { type KeyboardEvent, type PointerEvent, useCallback, useState } from "react";

import { makeCommandId } from "../runtime/commandId.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";
import { shellForPlatform } from "../sessions/launch.js";
import { MIN_DRAWER_HEIGHT } from "../sessions/workbench.js";
import { Icon } from "../ui/Icon.js";
import { TerminalView } from "./TerminalView.js";

const MAX_SPLITS = 4;

/** Shell terminals for a session, plus worktree shells that were opened before any session existed. */
export function drawerTerminals(
  terminals: readonly TerminalProjection[],
  worktreeId: string | undefined,
  sessionId: string | undefined,
): TerminalProjection[] {
  if (!worktreeId) return [];
  return terminals.filter(
    (terminal) =>
      terminal.kind !== "agent" &&
      terminal.worktreeId === worktreeId &&
      (terminal.sessionId === undefined || terminal.sessionId === sessionId),
  );
}

export function TerminalDrawer({
  projection,
  worktree,
  sessionId,
  height,
  onHeightChange,
  onClose,
}: {
  projection: RuntimeProjection;
  worktree: WorktreeProjection | undefined;
  sessionId: string | undefined;
  height: number;
  onHeightChange(height: number): void;
  onClose(): void;
}) {
  const { bridge, dispatch } = useRuntime();
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const panes = drawerTerminals(projection.terminals, worktree?.worktreeId, sessionId)
    .filter((terminal) => !dismissed.includes(terminal.terminalId))
    .slice(-MAX_SPLITS);

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
    await send({
      type: "terminal.create",
      terminalId: makeCommandId(),
      worktreeId: worktree.worktreeId,
      cwd: worktree.path,
      shell: shellForPlatform(),
      title: `Terminal ${panes.length + 1}`,
      cols: 120,
      rows: 24,
      ...(sessionId ? { sessionId } : {}),
    });
    setBusy(false);
  };

  const closePane = async (terminal: TerminalProjection) => {
    if (terminal.status === "running") await send({ type: "terminal.stop", terminalId: terminal.terminalId });
    setDismissed((current) => [...current, terminal.terminalId]);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    const startY = event.clientY;
    const startHeight = height;
    handle.setPointerCapture(event.pointerId);
    handle.classList.add("is-dragging");
    const onMove = (move: globalThis.PointerEvent) =>
      onHeightChange(clampDrawer(startHeight + (startY - move.clientY)));
    const onUp = () => {
      handle.classList.remove("is-dragging");
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowUp") onHeightChange(clampDrawer(height + 24));
    else if (event.key === "ArrowDown") onHeightChange(clampDrawer(height - 24));
    else return;
    event.preventDefault();
  };

  return (
    <section className="terminal-drawer" aria-label="Terminal panel" style={{ height }}>
      {/* biome-ignore lint/a11y/useSemanticElements: a focusable ARIA separator is the standard splitter pattern. */}
      <div
        className="drawer-resizer"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize terminal drawer"
        aria-valuemin={MIN_DRAWER_HEIGHT}
        aria-valuenow={height}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
      />
      <header className="drawer-header">
        <Icon name="terminal" size={13} />
        <h2>Terminal</h2>
        {worktree ? <span className="drawer-detail">{worktree.branch}</span> : null}
        <span className="drawer-spacer" />
        {panes.length > 0 ? (
          <button
            className="ghost-button"
            type="button"
            onClick={() => void createTerminal()}
            disabled={busy || panes.length >= MAX_SPLITS}
            title={
              panes.length >= MAX_SPLITS
                ? `Up to ${MAX_SPLITS} terminals side by side`
                : "Open another terminal beside this one"
            }
          >
            <Icon name="columns" size={13} />
            Split
          </button>
        ) : null}
        <button className="icon-button" type="button" onClick={onClose} aria-label="Close terminal drawer">
          <Icon name="x" size={14} />
        </button>
      </header>
      {!worktree ? (
        <div className="drawer-empty">
          <p>Select an agent or worktree to open a terminal in it.</p>
        </div>
      ) : panes.length === 0 ? (
        <div className="drawer-empty">
          <p>A shell in {worktree.branch}, next to the agent.</p>
          <button className="secondary-button" type="button" onClick={() => void createTerminal()} disabled={busy}>
            <Icon name="terminal" size={13} />
            {busy ? "Starting" : "Start terminal"}
          </button>
        </div>
      ) : (
        <div className="drawer-splits" style={{ gridTemplateColumns: `repeat(${panes.length}, minmax(0, 1fr))` }}>
          {panes.map((terminal) => (
            <div className="drawer-pane" key={terminal.terminalId}>
              <div className="drawer-pane-bar">
                <span className={`status-dot status-terminal-${terminal.status}`} aria-hidden="true" />
                <span className="drawer-pane-title">{terminal.title}</span>
                {terminal.status !== "running" ? (
                  <span className="drawer-pane-state">{terminal.status === "failed" ? "Failed" : "Exited"}</span>
                ) : null}
                <button
                  className="icon-button is-small"
                  type="button"
                  aria-label={terminal.status === "running" ? `Stop ${terminal.title}` : `Close ${terminal.title}`}
                  title={terminal.status === "running" ? "Stop and close" : "Close"}
                  onClick={() => void closePane(terminal)}
                >
                  <Icon name="x" size={12} />
                </button>
              </div>
              {bridge ? (
                <TerminalView
                  bridge={bridge}
                  terminalId={terminal.terminalId}
                  running={terminal.status === "running"}
                  send={send}
                />
              ) : null}
              {terminal.errorMessage ? (
                <p className="inline-error" role="alert">
                  {terminal.errorMessage}
                </p>
              ) : null}
            </div>
          ))}
        </div>
      )}
      {error ? (
        <p className="inline-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function clampDrawer(height: number): number {
  const max = typeof window === "undefined" ? 800 : Math.max(MIN_DRAWER_HEIGHT, Math.round(window.innerHeight * 0.7));
  return Math.min(max, Math.max(MIN_DRAWER_HEIGHT, Math.round(height)));
}
