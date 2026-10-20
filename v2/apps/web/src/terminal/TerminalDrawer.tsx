import type { RpcResponse, RuntimeProjection, TerminalProjection, WorktreeProjection } from "@zli-v2/contracts";
import { type KeyboardEvent, type PointerEvent, useCallback, useState } from "react";

import { useFileLinks } from "../files/FileIndex.js";
import { makeCommandId } from "../runtime/commandId.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";
import { shellForPlatform } from "../sessions/launch.js";
import { MIN_DRAWER_HEIGHT } from "../sessions/workbench.js";
import { Button, IconButton } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { EmptyState } from "../ui/Pane.js";
import { TerminalView } from "./TerminalView.js";
import "./terminal.css";

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
  const fileLinks = useFileLinks(worktree?.worktreeId);
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
          <Button
            variant="ghost"
            size="sm"
            icon="columns"
            onClick={() => void createTerminal()}
            disabled={busy || panes.length >= MAX_SPLITS}
            tooltip={
              panes.length >= MAX_SPLITS
                ? `Up to ${MAX_SPLITS} terminals side by side`
                : "Open another terminal beside this one"
            }
          >
            Split
          </Button>
        ) : null}
        <IconButton
          label="Close terminal drawer"
          tooltip="Hide terminal"
          shortcut="Mod+J"
          icon="x"
          size="sm"
          iconSize={14}
          onClick={onClose}
        />
      </header>
      {!worktree ? (
        <EmptyState
          className="drawer-empty"
          icon="terminal"
          title="No worktree selected"
          detail="Select an agent or worktree to open a terminal in it."
        />
      ) : panes.length === 0 ? (
        <EmptyState
          className="drawer-empty"
          icon="terminal"
          title={`A shell in ${worktree.branch}`}
          detail="Run commands next to the agent. Open up to four side by side."
        >
          <Button icon="terminal" loading={busy} onClick={() => void createTerminal()}>
            {busy ? "Starting" : "Start terminal"}
          </Button>
        </EmptyState>
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
                <IconButton
                  icon="x"
                  size="xs"
                  label={terminal.status === "running" ? `Stop ${terminal.title}` : `Close ${terminal.title}`}
                  tooltip={terminal.status === "running" ? "Stop and close" : "Close"}
                  onClick={() => void closePane(terminal)}
                />
              </div>
              {bridge ? (
                <TerminalView
                  bridge={bridge}
                  terminalId={terminal.terminalId}
                  running={terminal.status === "running"}
                  send={send}
                  fileLinks={fileLinks}
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
