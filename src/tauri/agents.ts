import { isCommandMissing, toAppError } from "../lib/errors";
import type { Agent, AgentProvider, LaunchAgentRequest } from "../types";
import { AGENT_COMMANDS } from "../types/commands";
import { invokeCmd } from "./invoke";

export async function listAgentProviders(): Promise<AgentProvider[]> {
  try {
    return await invokeCmd<AgentProvider[]>(AGENT_COMMANDS.listProviders);
  } catch (err) {
    const parsed = toAppError(err);
    if (!isCommandMissing(parsed)) throw parsed;
    return invokeCmd<AgentProvider[]>(AGENT_COMMANDS.detectProviders);
  }
}

export function launchAgent(request: LaunchAgentRequest): Promise<Agent> {
  return invokeCmd<Agent>(AGENT_COMMANDS.launch, {
    request,
  });
}

export function stopAgent(id: string): Promise<void> {
  return invokeCmd<void>(AGENT_COMMANDS.stop, { id });
}

export function listAgents(): Promise<Agent[]> {
  return invokeCmd<Agent[]>(AGENT_COMMANDS.list);
}
