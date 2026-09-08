import { memo, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { IconClose, IconSplitDown, IconSplitRight } from "./AppIcons";
import { ProviderIcon } from "./ProviderIcon";
import { StatusBadge } from "./StatusBadge";
import { rafThrottle } from "../lib/schedule";
import { useAgentStore } from "../stores/agentStore";
import { useLayoutStore } from "../stores/layoutStore";
import { useTerminalStore } from "../stores/terminalStore";
import { terminalRegistry } from "../terminal/registry";
import { providerDisplayName } from "../types";
import { providerAccent } from "../lib/providerPresentation";
import { launchAgent } from "../tauri/agents";
import { sessionFromAgent } from "../lib/terminalSessions";
import { replaceNode } from "../stores/paneTree";
import { toAppError } from "../lib/errors";
import { terminalRetry } from "../lib/terminalRetry";
import type { Agent } from "../types";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface TerminalPaneProps {
  paneId: string;
  terminalId: string;
}

export const TerminalPane = memo(function TerminalPane({ paneId, terminalId }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const retrying = useSyncExternalStore(terminalRetry.subscribe, () => terminalRetry.isRetrying(terminalId));
  const session = useTerminalStore((s) => s.sessions[terminalId]);
  const activePaneId = useLayoutStore((s) => s.activePaneId);
  const setActivePane = useLayoutStore((s) => s.setActivePane);
  const splitActive = useLayoutStore((s) => s.splitActive);
  const closePane = useLayoutStore((s) => s.closePane);
  const closeSession = useTerminalStore((s) => s.closeSession);
  const createSession = useTerminalStore((s) => s.createSession);
  const agent = useAgentStore((s) =>
    Object.values(s.agents).find((item) => item.terminalId === terminalId),
  );
  const active = activePaneId === paneId;
  const hasXterm = terminalRegistry.has(terminalId);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !hasXterm) return;
    terminalRegistry.attach(terminalId, el);
    const onResize = rafThrottle(() => {
      const dim = terminalRegistry.fit(terminalId);
      if (dim && dim.cols > 0 && dim.rows > 0) {
        useTerminalStore.getState().resizeSession(terminalId, dim.cols, dim.rows);
      }
    });
    const observer = new ResizeObserver(() => onResize());
    observer.observe(el);
    onResize();
    return () => {
      onResize.cancel();
      observer.disconnect();
      terminalRegistry.detach(terminalId, el);
    };
  }, [terminalId, hasXterm]);

  useEffect(() => {
    if (active && hasXterm) terminalRegistry.focus(terminalId);
  }, [active, hasXterm, terminalId]);

  function onFocusPane() {
    setActivePane(paneId);
    if (hasXterm) terminalRegistry.focus(terminalId);
  }

  async function onSplit(direction: "horizontal" | "vertical") {
    if (!session) return;
    const created = await createSession({
      cwd: session.cwd,
      cols: session.cols ?? 80,
      rows: session.rows ?? 24,
      title: "Terminal",
    });
    setActivePane(paneId);
    splitActive(created.id, direction);
  }

  async function onClose() {
    await terminalRetry.runExclusive(terminalId, async () => {
      const references = useLayoutStore.getState().leaves().filter((leaf) => leaf.terminalId === terminalId);
      const stillCurrent = () => useLayoutStore.getState().leaves().some(
        (leaf) => leaf.id === paneId && leaf.terminalId === terminalId,
      );
      if (!stillCurrent()) return;
      if (references.length > 1) {
        closePane(paneId);
        return;
      }

      const closed = await closeSession(terminalId);
      if (closed && stillCurrent()) {
        closePane(paneId);
        if (agent) useAgentStore.getState().remove(agent.id);
      } else if (!closed && stillCurrent()) {
        setDetailsOpen(true);
      }
    });
  }

  async function onRetry() {
    if (!session || terminalRetry.isRetrying(terminalId)) return;
    let restartedAgent: Agent | undefined;
    const isCurrent = () => useLayoutStore.getState().leaves().some((leaf) => leaf.id === paneId && leaf.terminalId === terminalId);
    await terminalRetry.run(terminalId, {
      isCurrent,
      closeOriginal: () => useTerminalStore.getState().stopSession(terminalId),
      create: async () => {
      const cols = session.cols ?? 80;
      const rows = session.rows ?? 24;
      if (agent) {
        const restarted = await launchAgent({ name: agent.name, provider: agent.provider, cwd: agent.worktreePath ?? agent.cwd, createWorktree: false, cols, rows });
        restartedAgent = restarted;
        const replacement = sessionFromAgent(restarted, cols, rows);
        useTerminalStore.getState().registerSession(replacement);
        return replacement;
      }
      return createSession({ cwd: session.cwd, title: session.title, cols, rows });
      },
      swap: (replacement) => {
        if (!isCurrent()) return false;
        const restarted = restartedAgent;
        if (agent && restarted) {
        useAgentStore.setState((state) => {
          const agents = { ...state.agents };
          delete agents[agent.id];
          agents[restarted.id] = { ...restarted, worktreePath: agent.worktreePath, branch: agent.branch };
          return { agents, selectedAgentId: state.selectedAgentId === agent.id ? restarted.id : state.selectedAgentId };
        });
        }
      useLayoutStore.setState((state) => ({
        paneTree: state.paneTree ? replaceNode(state.paneTree, paneId, { type: "leaf", id: paneId, terminalId: replacement.id }) : null,
      }));
        return true;
      },
      dispose: async (replacement) => {
        const closed = await closeSession(replacement.id);
        if (!closed) {
          useLayoutStore.getState().addLeaf(replacement.id);
          throw new Error("The replacement terminal could not be stopped and was kept visible.");
        }
      },
      releaseOriginal: async () => {
        if (!useLayoutStore.getState().leaves().some((leaf) => leaf.terminalId === terminalId)) await closeSession(terminalId);
      },
      fail: (error) => {
      useTerminalStore.getState().markError(terminalId, toAppError(error).message);
      setDetailsOpen(true);
      },
    });
  }

  const title = agent?.name ?? session?.title ?? "Terminal";
  const provider = agent ? providerDisplayName(agent.provider) : "Shell";
  const status = session?.status ?? "starting";

  return (
    <div
      className={`terminal-pane flex h-full min-h-0 min-w-0 flex-col ${active ? "is-active ring-1 ring-inset ring-accent/80" : ""}`}
      data-active={active}
      data-status={status}
      style={{ borderTop: `2px solid ${providerAccent(agent?.provider ?? session?.provider)}` }}
      onMouseDown={onFocusPane}
    >
      <div
        className="terminal-pane-header flex h-12 shrink-0 items-center gap-2 border-b border-line bg-chrome px-3"
      >
        <ProviderIcon provider={agent?.provider ?? "shell"} size="sm" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] font-medium text-paper">{title}</span>
          <span className="block truncate text-[11px] text-mute">{provider}</span>
        </span>
        <StatusBadge status={status} />
        <span className="flex shrink-0 items-center">
          <Tooltip><TooltipTrigger asChild><Button type="button" variant="ghost" size="icon-xs" aria-label="Split right" onClick={() => void onSplit("horizontal")}><IconSplitRight /></Button></TooltipTrigger><TooltipContent>Split right</TooltipContent></Tooltip>
          <Tooltip><TooltipTrigger asChild><Button type="button" variant="ghost" size="icon-xs" aria-label="Split down" onClick={() => void onSplit("vertical")}><IconSplitDown /></Button></TooltipTrigger><TooltipContent>Split down</TooltipContent></Tooltip>
          <Tooltip><TooltipTrigger asChild><Button type="button" variant="ghost" size="icon-xs" aria-label="Close pane" disabled={retrying} onClick={() => void onClose()}><IconClose /></Button></TooltipTrigger><TooltipContent>Close pane</TooltipContent></Tooltip>
        </span>
      </div>
      {status === "error" || status === "failed" || status === "exited" || status === "killed" ? (
        <div className="shrink-0 border-b border-line bg-chrome px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <span role="status" className="text-[12px] text-paper">
              {status === "exited" || status === "killed" ? "Process ended" : "Terminal needs attention"}
            </span>
            <span className="flex gap-2">
              <Button type="button" variant="secondary" size="sm" disabled={retrying} onClick={() => void onRetry()}>{retrying ? "Retrying…" : "Retry"}</Button>
              <Button type="button" variant="ghost" size="sm" aria-expanded={detailsOpen} aria-controls={`terminal-details-${paneId}`} onClick={() => setDetailsOpen((open) => !open)}>Details</Button>
            </span>
          </div>
          {detailsOpen ? <div id={`terminal-details-${paneId}`} className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] text-mute">
            {status === "exited" || status === "killed"
              ? `Process ${status}${session?.exitCode != null ? ` (${session.exitCode})` : ""}.`
              : session?.error ?? "Terminal failed to start."}
          </div> : null}
        </div>
      ) : null}
      <div className="terminal-pane-body relative min-h-0 min-w-0 flex-1 bg-[#0b0e14]">
        {status === "starting" ? (
          <div role="status" className="terminal-starting pointer-events-none absolute left-3 top-2 z-10 px-2 py-1 text-[12px] text-slate-300">Starting terminal…</div>
        ) : null}
        <div ref={containerRef} className="h-full min-h-0 min-w-0" />
      </div>
    </div>
  );
});
