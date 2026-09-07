import { memo, useEffect, useRef } from "react";
import { IconClose, IconSplitDown, IconSplitRight } from "./AppIcons";
import { ProviderIcon } from "./ProviderIcon";
import { StatusBadge } from "./StatusBadge";
import { rafThrottle } from "../lib/schedule";
import { useAgentStore } from "../stores/agentStore";
import { useLayoutStore } from "../stores/layoutStore";
import { useTerminalStore } from "../stores/terminalStore";
import { terminalRegistry } from "../terminal/registry";
import { providerDisplayName } from "../types";

interface TerminalPaneProps {
  paneId: string;
  terminalId: string;
}

export const TerminalPane = memo(function TerminalPane({ paneId, terminalId }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
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

  function onClose() {
    const terminalToClose = closePane(paneId);
    if (!terminalToClose) return;
    const stillOpen = useLayoutStore
      .getState()
      .leaves()
      .some((leaf) => leaf.terminalId === terminalToClose);
    if (!stillOpen) void closeSession(terminalToClose);
  }

  const title = agent?.name ?? session?.title ?? "Terminal";
  const provider = agent ? providerDisplayName(agent.provider) : "Shell";
  const status = session?.status ?? "starting";

  return (
    <div
      className={`flex h-full min-h-0 min-w-0 flex-col ${active ? "ring-1 ring-inset ring-accent/80" : ""}`}
      onMouseDown={onFocusPane}
    >
      <div
        className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-chrome px-2.5"
      >
        <ProviderIcon provider={agent?.provider ?? "shell"} size="sm" />
        <span className="truncate text-[12px] font-medium text-paper">{title}</span>
        <span className="truncate text-[11px] text-mute">{provider}</span>
        <StatusBadge status={status} />
        <span className="ml-auto flex items-center gap-0.5">
          <button
            type="button"
            className="btn btn-icon"
            title="Split right"
            aria-label="Split right"
            onClick={() => void onSplit("horizontal")}
          >
            <IconSplitRight />
          </button>
          <button
            type="button"
            className="btn btn-icon"
            title="Split down"
            aria-label="Split down"
            onClick={() => void onSplit("vertical")}
          >
            <IconSplitDown />
          </button>
          <button
            type="button"
            className="btn btn-icon"
            title="Close pane"
            aria-label="Close pane"
            onClick={onClose}
          >
            <IconClose />
          </button>
        </span>
      </div>
      {status === "error" || status === "failed" || status === "exited" || status === "killed" ? (
        <div className="banner banner-error rounded-none border-x-0">
          {status === "exited" || status === "killed"
            ? `Process ${status}${session?.exitCode != null ? ` (${session.exitCode})` : ""}.`
            : session?.error ?? "Terminal failed to start."}
        </div>
      ) : null}
      {status === "starting" && !hasXterm ? (
        <div className="px-2 py-1 text-[12px] text-warn">Starting terminal…</div>
      ) : null}
      <div ref={containerRef} className="min-h-0 min-w-0 flex-1 bg-black" />
    </div>
  );
});
