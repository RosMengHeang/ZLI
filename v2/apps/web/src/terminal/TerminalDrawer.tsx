import type { RpcResponse, RuntimeProjection, TerminalProjection, WorktreeProjection } from "@zli-v2/contracts";
import { type KeyboardEvent, type PointerEvent, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useFileLinks } from "../files/FileIndex.js";
import { makeCommandId } from "../runtime/commandId.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";
import { shellForPlatform } from "../sessions/launch.js";
import { MIN_DRAWER_HEIGHT } from "../sessions/workbench.js";
import { useShortcut } from "../shell/keybindings.js";
import { Button, IconButton } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { LazyTerminalView } from "./LazyTerminalView.js";
import { markPanelTerminal, usePanelTerminals } from "./panelTerminals.js";
import "./terminal.css";

/** How many shells one worktree keeps open in the drawer. */
export const MAX_TERMINALS = 10;

/**
 * The worktree's shells, whichever chat opened them, so switching chats on a branch keeps its terminals. A shell
 * that exited is gone; one that failed stays so its error can be read. Agent CLIs live in their tiles instead.
 */
export function drawerTerminals(
  terminals: readonly TerminalProjection[],
  worktreeId: string | undefined,
): TerminalProjection[] {
  if (!worktreeId) return [];
  return terminals.filter(
    (terminal) => terminal.kind !== "agent" && terminal.worktreeId === worktreeId && terminal.status !== "exited",
  );
}

/** The next free "Terminal N" title among the worktree's shells. */
export function nextTerminalTitle(terminals: readonly TerminalProjection[]): string {
  const used = terminals.map((terminal) => Number(/^Terminal (\d+)$/u.exec(terminal.title ?? "")?.[1] ?? 0));
  return `Terminal ${Math.max(0, ...used) + 1}`;
}

export function TerminalDrawer({
  projection,
  worktree,
  sessionId,
  height: shownHeight,
  maxHeight = MIN_DRAWER_HEIGHT,
  onHeightChange: changeHeight,
  autoStart = true,
  onClose,
  place = "bottom",
  tabsHost,
  newRequest,
}: {
  projection: RuntimeProjection;
  worktree: WorktreeProjection | undefined;
  sessionId: string | undefined;
  /** The height the drawer has now, which can be less than the remembered one in a small window. */
  height?: number;
  /** The most the window leaves the drawer above the agent grid. */
  maxHeight?: number;
  onHeightChange?(height: number): void;
  /** Starts a shell when the drawer opens on a place with none. Off when something opened it to show its own. */
  autoStart?: boolean;
  onClose(): void;
  /** The drawer at the bottom, or the right panel's own terminal. Each keeps its own shells. */
  place?: "bottom" | "side" | undefined;
  /** Beside the chat: where each shell's tab goes, in the right panel's strip. */
  tabsHost?: HTMLElement | null | undefined;
  /** Beside the chat: a new number asks for one more shell. */
  newRequest?: number | undefined;
}) {
  const side = place === "side";
  const panelIds = usePanelTerminals();
  const { bridge, dispatch } = useRuntime();
  const drawerShortcut = useShortcut("toggleDrawer");
  const [dismissed, setDismissed] = useState<string[]>([]);
  // A stopped pane stays until the runtime reports its shell gone, so a shell that ignores the stop is not hidden.
  const [stopping, setStopping] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const fileLinks = useFileLinks(worktree?.worktreeId);
  const panes = drawerTerminals(projection.terminals, worktree?.worktreeId)
    .filter(
      (terminal) =>
        panelIds.has(terminal.terminalId) === side &&
        !dismissed.includes(terminal.terminalId) &&
        !(stopping.includes(terminal.terminalId) && terminal.status !== "running"),
    )
    .slice(-MAX_TERMINALS);
  // One shell shows at a time; the tabs in the header switch between them. A new shell takes the front.
  const [activeId, setActiveId] = useState<string>();
  const active = panes.find((terminal) => terminal.terminalId === activeId) ?? panes.at(-1);

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
    if (!worktree || panes.length >= MAX_TERMINALS) return;
    setBusy(true);
    setError(undefined);
    const terminalId = makeCommandId();
    if (side) markPanelTerminal(terminalId);
    const response = await send({
      type: "terminal.create",
      terminalId,
      worktreeId: worktree.worktreeId,
      cwd: worktree.path,
      shell: shellForPlatform(),
      // The bottom drawer and the right panel count their shells apart: each starts at Terminal 1.
      title: nextTerminalTitle(
        drawerTerminals(projection.terminals, worktree.worktreeId).filter(
          (terminal) => panelIds.has(terminal.terminalId) === side,
        ),
      ),
      cols: 120,
      rows: 24,
      ...(sessionId ? { sessionId } : {}),
    });
    if (response?.accepted !== false) setActiveId(terminalId);
    setBusy(false);
  };

  // Opening the drawer starts a shell right away when the worktree has none. Once per worktree while the drawer
  // stays open, so closing the last shell leaves the drawer empty instead of starting another.
  const autoStarted = useRef<string | undefined>(undefined);
  const placeKey = worktree?.worktreeId;
  const hasPanes = panes.length > 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: createTerminal reads the latest worktree and chat on purpose.
  useEffect(() => {
    if (!placeKey || autoStarted.current === placeKey) return;
    // A place that already shows shells counts as started, so closing its last one does not open another.
    if (hasPanes) {
      autoStarted.current = placeKey;
      return;
    }
    if (!autoStart) return;
    autoStarted.current = placeKey;
    void createTerminal();
  }, [placeKey, hasPanes, autoStart]);

  const seenRequest = useRef(newRequest);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new request starts a shell.
  useEffect(() => {
    if (newRequest === undefined || newRequest === seenRequest.current) return;
    seenRequest.current = newRequest;
    void createTerminal();
  }, [newRequest]);

  const closePane = async (terminal: TerminalProjection) => {
    const terminalId = terminal.terminalId;
    // Closing the last shell closes the drawer too; the next open starts a fresh one.
    if (panes.length === 1) onClose();
    if (terminal.status !== "running") {
      setDismissed((current) => [...current, terminalId]);
      return;
    }
    setStopping((current) => (current.includes(terminalId) ? current : [...current, terminalId]));
    const response = await send({ type: "terminal.stop", terminalId });
    if (response?.accepted !== true) setStopping((current) => current.filter((id) => id !== terminalId));
  };

  const height = shownHeight ?? MIN_DRAWER_HEIGHT;
  const onHeightChange = (next: number) => changeHeight?.(next);
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

  // The right panel's tab closes its terminal, so it needs no close button of its own.
  const closeButton = side ? null : (
    <IconButton
      label="Close terminal drawer"
      tooltip="Hide terminal"
      shortcut={drawerShortcut}
      icon="x"
      size="sm"
      iconSize={14}
      onClick={onClose}
    />
  );
  const errorLine = error ? (
    <p className="inline-error" role="alert">
      {error}
    </p>
  ) : null;

  // Without a running shell the drawer is one row, so opening it does not take space from the agents.
  if (panes.length === 0) {
    return (
      <section
        className={`terminal-drawer is-compact${side ? " is-side" : ""}`}
        aria-label={side ? "Side terminal" : "Terminal panel"}
      >
        <header className="drawer-header">
          <Icon name="terminal" size={13} />
          <h2>Terminal</h2>
          <span className="drawer-note">
            {worktree ? (
              <>
                No shell in <span className="drawer-detail">{worktree.branch}</span>
              </>
            ) : (
              "Select an agent or worktree to open a terminal in it."
            )}
          </span>
          <span className="drawer-spacer" />
          {worktree ? (
            <Button
              size="sm"
              icon="terminal"
              loading={busy}
              tooltip="Open a shell in this worktree."
              onClick={() => void createTerminal()}
            >
              {busy ? "Starting" : "Start terminal"}
            </Button>
          ) : null}
          {closeButton}
        </header>
        {errorLine}
      </section>
    );
  }

  const sideTabs =
    side && tabsHost
      ? createPortal(
          panes.map((terminal) => {
            const isActive = terminal.terminalId === active?.terminalId;
            return (
              <div
                key={terminal.terminalId}
                className={`panel-strip-tab is-shell${isActive ? " is-active" : ""}`}
                title={terminal.title}
              >
                <button
                  type="button"
                  role="tab"
                  className="panel-strip-pick"
                  aria-selected={isActive}
                  aria-controls={`drawer-pane-${terminal.terminalId}`}
                  onClick={() => setActiveId(terminal.terminalId)}
                  onAuxClick={(event) => {
                    if (event.button === 1) void closePane(terminal);
                  }}
                >
                  <span className={`status-dot status-terminal-${terminal.status}`} aria-hidden="true" />
                  <span className="panel-strip-label">{terminal.title}</span>
                </button>
                <button
                  type="button"
                  className="panel-strip-close"
                  aria-label={terminal.status === "running" ? `Stop ${terminal.title}` : `Close ${terminal.title}`}
                  onClick={() => void closePane(terminal)}
                >
                  <Icon name="x" size={11} />
                </button>
              </div>
            );
          }),
          tabsHost,
        )
      : null;

  return (
    <section
      className={`terminal-drawer${side ? " is-side" : ""}`}
      aria-label={side ? "Side terminal" : "Terminal panel"}
      style={side ? undefined : { height }}
    >
      {side ? null : (
        // biome-ignore lint/a11y/useSemanticElements: a focusable ARIA separator is the standard splitter pattern.
        <div
          className="drawer-resizer"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize terminal drawer"
          aria-valuemin={Math.min(MIN_DRAWER_HEIGHT, maxHeight)}
          aria-valuemax={Math.min(maxHeight, drawerCap())}
          aria-valuenow={height}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onKeyDown={onKeyDown}
        />
      )}
      {sideTabs}
      <header className="drawer-header" hidden={side}>
        <div className="drawer-tabs" role="tablist" aria-label="Terminals">
          {panes.map((terminal) => {
            const isActive = terminal.terminalId === active?.terminalId;
            const isStopping = stopping.includes(terminal.terminalId);
            return (
              <div key={terminal.terminalId} className={`drawer-tab${isActive ? " is-active" : ""}`}>
                <button
                  type="button"
                  role="tab"
                  className="drawer-tab-pick"
                  aria-selected={isActive}
                  aria-controls={`drawer-pane-${terminal.terminalId}`}
                  onClick={() => setActiveId(terminal.terminalId)}
                >
                  <span className={`status-dot status-terminal-${terminal.status}`} aria-hidden="true" />
                  <span className="drawer-tab-title">{terminal.title}</span>
                  {terminal.status === "failed" ? <span className="drawer-pane-state">Failed</span> : null}
                  {isStopping ? <span className="drawer-pane-state">Stopping</span> : null}
                </button>
                <IconButton
                  icon="x"
                  size="xs"
                  iconSize={12}
                  label={terminal.status === "running" ? `Stop ${terminal.title}` : `Close ${terminal.title}`}
                  tooltip={terminal.status !== "running" ? "Close" : isStopping ? "Stop it now" : "Stop and close"}
                  onClick={() => void closePane(terminal)}
                />
              </div>
            );
          })}
          <IconButton
            icon="plus"
            size="sm"
            iconSize={14}
            label="New terminal"
            tooltip={panes.length >= MAX_TERMINALS ? `Up to ${MAX_TERMINALS} terminals` : "New terminal"}
            disabled={busy || panes.length >= MAX_TERMINALS}
            onClick={() => void createTerminal()}
          />
        </div>
        <span className="drawer-spacer" />
        {worktree ? <span className="drawer-detail">{worktree.branch}</span> : null}
        {closeButton}
      </header>
      <div className="drawer-splits">
        {panes.map((terminal) => (
          <div
            className="drawer-pane"
            key={terminal.terminalId}
            id={`drawer-pane-${terminal.terminalId}`}
            role="tabpanel"
            hidden={terminal.terminalId !== active?.terminalId}
          >
            {bridge ? (
              <LazyTerminalView
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
      {errorLine}
    </section>
  );
}

function drawerCap(): number {
  return typeof window === "undefined" ? 800 : Math.max(MIN_DRAWER_HEIGHT, Math.round(window.innerHeight * 0.7));
}

function clampDrawer(height: number): number {
  return Math.min(drawerCap(), Math.max(MIN_DRAWER_HEIGHT, Math.round(height)));
}
