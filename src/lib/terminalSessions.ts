import type { Agent, SessionStatus, TerminalSession } from "../types";

function sessionStatus(agent: Agent): SessionStatus {
  if (agent.status === "running") return "running";
  if (agent.status === "exited") return "exited";
  return "error";
}

export function sessionFromAgent(agent: Agent, cols: number, rows: number): TerminalSession {
  return {
    id: agent.terminalId,
    cwd: agent.cwd,
    status: sessionStatus(agent),
    title: agent.name,
    provider: agent.provider,
    cols,
    rows,
    error: agent.error ?? null,
  };
}
