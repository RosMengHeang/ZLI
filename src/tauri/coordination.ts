import { controlClient } from "../control/client.ts";

export interface AgentQueueStatus {
  projectId: string;
  agentId: string;
  pendingCount: number;
  inFlightCount: number;
  oldestMessageId: string | null;
}

export function getAgentQueueStatus(projectId?: string): Promise<AgentQueueStatus[]> {
  return controlClient.request<AgentQueueStatus[]>(
    "agent.queue_status",
    projectId ? { projectId } : {},
  );
}
