import { useEffect, useMemo, useState } from "react";
import { ProviderIcon } from "./ProviderIcon";
import { useAgentStore } from "../stores/agentStore";
import { useTeamStore } from "../stores/teamStore";
import { useProjectStore } from "../stores/projectStore";
import { controlClient } from "../control/client";
import { Button } from "@/components/ui/button";

interface AgentQueueStatus {
  projectId: string;
  agentId: string;
  pendingCount: number;
  inFlightCount: number;
}

const QUEUE_REFRESH_MS = 5_000;

export function TeamPanel() {
  const spawns = useTeamStore((state) => state.spawns);
  const deliveries = useTeamStore((state) => state.deliveries);
  const agents = useTeamStore((state) => state.agents);
  const project = useProjectStore((state) => state.project);
  const agentRecords = useAgentStore((state) => state.agents);
  const [queueStatus, setQueueStatus] = useState<AgentQueueStatus[]>([]);
  const [queueProjectId, setQueueProjectId] = useState<string | null>(null);
  const [queueError, setQueueError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    const projectId = project?.path;
    if (!projectId) {
      return () => {
        disposed = true;
      };
    }

    const refresh = async () => {
      try {
        const result = await controlClient.request<AgentQueueStatus[]>("agent.queue_status", { projectId }, { timeoutMs: 5_000 });
        if (!disposed) {
          setQueueProjectId(projectId);
          setQueueStatus(result.filter((status) => status.pendingCount > 0 || status.inFlightCount > 0));
          setQueueError(null);
        }
      } catch (caught) {
        if (!disposed) {
          setQueueProjectId(projectId);
          setQueueError(caught instanceof Error ? caught.message : "Queue status unavailable");
        }
      }
    };

    void refresh();
    const timer = window.setInterval(() => void refresh(), QUEUE_REFRESH_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [project?.path]);

  const activities = useMemo(() => [
    ...Object.values(spawns).map((spawn) => ({
      id: spawn.id,
      label: spawn.name?.trim() || `${spawn.providerId} child`,
      providerId: spawn.providerId,
      detail: spawn.error ?? (spawn.status === "pending" ? "Creating worktree and starting…" : "Agent started"),
      status: spawn.status,
      agentId: spawn.agentId,
    })),
    ...Object.values(deliveries).map((delivery) => ({
      id: delivery.id,
      label: agents[delivery.agentId]?.name ?? "Agent message",
      providerId: agents[delivery.agentId]?.providerId,
      detail: delivery.error ?? (delivery.status === "pending"
        ? "Submitting…"
        : delivery.status === "queued" ? "Waiting for the agent prompt" : "Message delivered"),
      status: delivery.status,
      agentId: delivery.agentId,
    })),
  ].slice(-6).reverse(), [agents, deliveries, spawns]);

  const visibleQueueStatus = queueProjectId === project?.path ? queueStatus : [];
  const visibleQueueError = queueProjectId === project?.path ? queueError : null;
  if (!activities.length && !visibleQueueStatus.length) return null;

  const queuedMessageCount = visibleQueueStatus.reduce((count, status) => count + status.pendingCount + status.inFlightCount, 0);
  const activityCount = activities.filter((item) => item.status === "pending").length || activities.length;

  return (
    <details className="team-activity">
      <summary>
        <span>Team activity</span>
        <span>{activityCount || queuedMessageCount}</span>
      </summary>
      <div className="team-activity-list" aria-live="polite">
        {activities.map((activity) => (
          <div key={activity.id} className="team-activity-row" data-status={activity.status}>
            {activity.providerId ? <ProviderIcon provider={activity.providerId} size="sm" bare /> : null}
            <div>
              <strong>{activity.label}</strong>
              <span>{activity.detail}</span>
            </div>
            {activity.agentId && activity.status !== "failed" && activity.status !== "pending" ? (
              <Button type="button" variant="ghost" size="xs" onClick={() => useAgentStore.getState().selectAgent(activity.agentId)}>
                Focus
              </Button>
            ) : null}
          </div>
        ))}
      </div>
      {visibleQueueStatus.length ? (
        <div className="team-queue" aria-label="Queued agent messages">
          <div className="team-queue-heading">Delivery queue</div>
          {visibleQueueStatus.map((status) => {
            const agent = agentRecords[status.agentId];
            const total = status.pendingCount + status.inFlightCount;
            return (
              <div key={status.agentId} className="team-queue-row">
                {agent?.provider ? <ProviderIcon provider={agent.provider} size="sm" bare /> : null}
                <span className="team-queue-name">{agent?.name ?? "Unavailable agent"}</span>
                <span className="team-queue-count">
                  {total} {total === 1 ? "message" : "messages"}
                  {status.inFlightCount ? ` · ${status.inFlightCount} in flight` : ""}
                </span>
              </div>
            );
          })}
        </div>
      ) : visibleQueueError && activities.length ? (
        <p className="team-queue-error" role="status">Delivery queue status unavailable. Recent activity is still shown.</p>
      ) : null}
    </details>
  );
}
