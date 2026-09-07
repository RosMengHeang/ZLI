import type { AgentProviderId } from "../../types";

export const MIN_AGENT_COUNT = 1;
export const MAX_AGENT_COUNT = 6;

export interface AgentDraft {
  id: string;
  provider: AgentProviderId;
  role: string;
  count: number;
  useWorktree: boolean;
}

export interface LaunchPlanItem {
  provider: AgentProviderId;
  name: string;
  useWorktree: boolean;
}

export function clampAgentCount(count: number): number {
  if (!Number.isFinite(count)) return MIN_AGENT_COUNT;
  return Math.min(
    MAX_AGENT_COUNT,
    Math.max(MIN_AGENT_COUNT, Math.trunc(count)),
  );
}

export interface LaunchProgress extends LaunchPlanItem {
  status: "waiting" | "starting" | "running" | "failed";
  error?: string;
}

// Retry preserves the original plan and never schedules successful rows.
export function pendingLaunchIndexes(
  items: LaunchProgress[],
  retry: boolean,
): number[] {
  return items.flatMap((item, index) =>
    item.status === (retry ? "failed" : "waiting") ? [index] : [],
  );
}

export function plannedAgentCount(
  rows: Array<Pick<AgentDraft, "count">>,
): number {
  return rows.reduce((total, row) => total + clampAgentCount(row.count), 0);
}

export function expandLaunchPlan(rows: AgentDraft[]): LaunchPlanItem[] {
  return rows.flatMap((row) => {
    const count = clampAgentCount(row.count);
    const baseName = row.role.trim() || row.provider;

    return Array.from({ length: count }, (_, index) => ({
      provider: row.provider,
      name: count > 1 ? `${baseName} ${index + 1}` : baseName,
      useWorktree: row.useWorktree,
    }));
  });
}
