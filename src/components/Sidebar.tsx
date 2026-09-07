import { StatusBadge } from "./StatusBadge";
import { useAgentStore } from "../stores/agentStore";
import { useGitStore } from "../stores/gitStore";
import { useUiStore } from "../stores/uiStore";
import { providerDisplayName } from "../types";

export function Sidebar() {
  const agents = useAgentStore((s) => Object.values(s.agents));
  const selectedAgentId = useAgentStore((s) => s.selectedAgentId);
  const selectAgent = useAgentStore((s) => s.selectAgent);
  const setAddAgentOpen = useUiStore((s) => s.setAddAgentOpen);
  const statusByPath = useGitStore((s) => s.statusByPath);

  return (
    <aside className="flex h-full min-w-0 flex-col bg-[#252526]">
      <div className="flex h-7 items-center justify-between border-b border-[#3e3e42] px-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[#8b8b8b]">
          Agents
        </span>
        <button
          type="button"
          className="px-1 text-[12px] text-[#cccccc] hover:bg-[#3e3e42]"
          onClick={() => setAddAgentOpen(true)}
          title="Add agent"
        >
          +
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {agents.length === 0 ? (
          <div className="px-2 py-3 text-[11px] leading-5 text-[#8b8b8b]">
            No agents yet. Launch Claude Code, Codex, Cursor Agent, or a terminal.
          </div>
        ) : (
          agents.map((agent) => {
            const gitPath = agent.worktreePath || agent.cwd;
            const changed = statusByPath[gitPath]?.changedFiles.length ?? 0;
            const active = agent.id === selectedAgentId;
            return (
              <button
                key={agent.id}
                type="button"
                onClick={() => selectAgent(agent.id)}
                className={`block w-full border-b border-[#2d2d2d] px-2 py-1.5 text-left hover:bg-[#2a2d2e] ${
                  active ? "bg-[#37373d]" : ""
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium text-white">{agent.name}</span>
                  <StatusBadge status={agent.status} />
                </div>
                <div className="truncate text-[11px] text-[#9cdcfe]">
                  {providerDisplayName(agent.provider)}
                </div>
                <div className="flex items-center justify-between gap-2 text-[11px] text-[#8b8b8b]">
                  <span className="truncate">{agent.branch || "—"}</span>
                  {changed > 0 ? (
                    <span className="text-[#cca700]">{changed} files</span>
                  ) : null}
                </div>
                {agent.error ? (
                  <div className="mt-0.5 truncate text-[11px] text-[#f14c4c]" title={agent.error}>
                    {agent.error}
                  </div>
                ) : null}
              </button>
            );
          })
        )}
      </div>
    </aside>
  );
}
