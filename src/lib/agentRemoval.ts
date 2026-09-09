export interface AgentRemovalTarget {
  agentId: string;
  terminalId: string;
  paneIds: string[];
}

interface AgentRemovalOperations {
  stopAgent: (id: string) => Promise<unknown>;
  closeTerminal: (id: string) => Promise<boolean>;
  closePane: (id: string) => void;
  beforeRemove?: () => Promise<unknown>;
  removeAgent: (id: string) => void;
}

export async function releaseAgentResources(
  target: AgentRemovalTarget,
  operations: AgentRemovalOperations,
): Promise<void> {
  await operations.stopAgent(target.agentId);
  const closed = await operations.closeTerminal(target.terminalId);
  if (!closed) throw new Error("The agent stopped, but its terminal could not be closed.");
  target.paneIds.forEach(operations.closePane);
  await operations.beforeRemove?.();
  operations.removeAgent(target.agentId);
}
