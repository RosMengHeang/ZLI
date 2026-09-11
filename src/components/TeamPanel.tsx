import { useMemo } from "react";
import { ProviderIcon } from "./ProviderIcon";
import { useAgentStore } from "../stores/agentStore";
import { useTeamStore } from "../stores/teamStore";
import { Button } from "@/components/ui/button";

export function TeamPanel() {
  const spawns = useTeamStore((state) => state.spawns);
  const deliveries = useTeamStore((state) => state.deliveries);
  const agents = useTeamStore((state) => state.agents);
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

  if (!activities.length) return null;

  return (
    <details className="team-activity">
      <summary>
        <span>Team activity</span>
        <span>{activities.filter((item) => item.status === "pending").length || activities.length}</span>
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
    </details>
  );
}
