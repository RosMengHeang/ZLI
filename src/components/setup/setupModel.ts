import {
  providerDisplayName,
  type AgentProvider,
  type AgentProviderId,
} from "../../types/models.ts";

export const MIN_AGENT_COUNT = 1;
export const MAX_AGENT_COUNT = 12;
export const MAX_TOTAL_AGENT_COUNT = 12;

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

export interface ProviderSelection {
  id: AgentProviderId;
  displayName: string;
  executable: string;
  installed: boolean;
  ready: boolean;
  count: number;
  selected: boolean;
}

export function clampProviderQuantity(quantity: number): number {
  if (!Number.isFinite(quantity)) return 0;
  return Math.min(MAX_AGENT_COUNT, Math.max(0, Math.trunc(quantity)));
}

export function setProviderQuantity(
  rows: AgentDraft[],
  provider: AgentProviderId,
  quantity: number,
): AgentDraft[] {
  const firstIndex = rows.findIndex((row) => row.provider === provider);
  const withoutDuplicates = rows.filter(
    (row, index) => row.provider !== provider || index === firstIndex,
  );
  const otherTotal = withoutDuplicates
    .filter((row) => row.provider !== provider)
    .reduce((total, row) => total + clampAgentCount(row.count), 0);
  const count = Math.min(
    clampProviderQuantity(quantity),
    Math.max(0, MAX_TOTAL_AGENT_COUNT - otherTotal),
  );

  if (count === 0) {
    return withoutDuplicates.filter((row) => row.provider !== provider);
  }

  if (firstIndex < 0) {
    return [
      ...rows,
      {
        id: `provider-${provider}`,
        provider,
        role: providerDisplayName(provider),
        count,
        useWorktree: provider !== "shell",
      },
    ];
  }

  return withoutDuplicates.map((row) =>
    row.provider === provider ? { ...row, count } : row,
  );
}

export function providerSelectionState(
  providers: AgentProvider[],
  rows: AgentDraft[],
): ProviderSelection[] {
  return providers.map((provider) => {
    const count = rows
      .filter((row) => row.provider === provider.id)
      .reduce((total, row) => total + clampAgentCount(row.count), 0);
    const ready = provider.id === "shell" || provider.installed;
    return {
      ...provider,
      ready,
      count,
      selected: count > 0,
    };
  });
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
  return Math.min(
    MAX_TOTAL_AGENT_COUNT,
    rows.reduce((total, row) => total + clampAgentCount(row.count), 0),
  );
}

export function canEnterWorkspace(project: { path: string } | null | undefined): boolean {
  return Boolean(project?.path.trim());
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
  }).slice(0, MAX_TOTAL_AGENT_COUNT);
}
