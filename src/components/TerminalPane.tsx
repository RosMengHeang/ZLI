import { useEffect, useRef } from "react";
import { StatusBadge } from "./StatusBadge";
import { useAgentStore } from "../stores/agentStore";
import { useLayoutStore } from "../stores/layoutStore";
import { useTerminalStore } from "../stores/terminalStore";
import { terminalRegistry } from "../terminal/registry";
import { providerDisplayName } from "../types";

interface TerminalPaneProps {
  paneId: string;
  terminalId: string;
}

const PROVIDER_ACCENTS: Record<string, string> = {
  "claude-code": "#d29922",
  codex: "#4ec9b0",
  "cursor-agent": "#9cdcfe",
  opencode: "#c586c0",
  gemini: "#8cc84b",
  aider: "#f97583",
  goose: "#f2cc60",
  shell: "#808080",
};

export function TerminalPane({ paneId, terminalId }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const session = useTerminalStore((s) => s.sessions[terminalId]);
  const resizeSession = useTerminalStore((s) => s.resizeSession);
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
    const observer = new ResizeObserver(() => {
      const dim = terminalRegistry.fit(terminalId);
      if (dim && dim.cols > 0 && dim.rows > 0) {
        void resizeSession(terminalId, dim.cols, dim.rows);
      }
    });
    observer.observe(el);
    if (active) terminalRegistry.focus(terminalId);
    return () => {
      observer.disconnect();
      terminalRegistry.detach(terminalId, el);
    };
  }, [terminalId, hasXterm, active, resizeSession]);

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
  const accent = agent ? PROVIDER_ACCENTS[agent.provider] ?? "#4ec9b0" : PROVIDER_ACCENTS.shell;

  return (
    <div
      className={`flex h-full min-h-0 min-w-0 flex-col ${active ? "ring-1 ring-inset ring-[#0e639c]" : ""}`}
      onMouseDown={onFocusPane}
    >
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-[#3e3e42] bg-[#292b2e] px-2" style={{ borderTop: `2px solid ${accent}` }}>
        <span className="truncate text-[11px] font-medium text-white">{title}</span>
        <span className="truncate text-[11px] text-[#8b8b8b]">{provider}</span>
        <StatusBadge status={status} />
        <span className="ml-auto flex items-center gap-0.5">
          <button
            type="button"
            className="px-1 text-[11px] text-[#8b8b8b] hover:bg-[#3e3e42] hover:text-white"
            title="Split right"
            onClick={() => void onSplit("horizontal")}
          >
            ‖
          </button>
          <button
            type="button"
            className="px-1 text-[11px] text-[#8b8b8b] hover:bg-[#3e3e42] hover:text-white"
            title="Split down"
            onClick={() => void onSplit("vertical")}
          >
            ═
          </button>
          <button
            type="button"
            className="px-1 text-[11px] text-[#8b8b8b] hover:bg-[#3e3e42] hover:text-white"
            title="Close pane"
            onClick={onClose}
          >
            ×
          </button>
        </span>
      </div>
      {status === "error" || status === "failed" || status === "exited" || status === "killed" ? (
        <div className="border-b border-[#3e3e42] bg-[#2a1f1f] px-2 py-1 text-[11px] text-[#f14c4c]">
          {status === "exited" || status === "killed"
            ? `Process ${status}${session?.exitCode != null ? ` (${session.exitCode})` : ""}.`
            : session?.error ?? "Terminal failed to start."}
        </div>
      ) : null}
      {status === "starting" && !hasXterm ? (
        <div className="px-2 py-1 text-[11px] text-[#cca700]">Starting terminal…</div>
      ) : null}
      <div ref={containerRef} className="min-h-0 min-w-0 flex-1 bg-[#1e1e1e]" />
    </div>
  );
}
