import type { UpdateStatus } from "@zli-v2/contracts";

/** One sentence on where the update stands, for Settings. */
export function updateStatusText(status: UpdateStatus): string {
  if (status.disabledReason) return status.disabledReason;
  const { state } = status;
  switch (state.status) {
    case "idle":
      return status.lastCheckedAt ? "ZLI is up to date." : "ZLI checks for updates a few seconds after it starts.";
    case "checking":
      return "Checking for updates.";
    case "available":
      if (!state.canAutoInstall) {
        return `ZLI ${state.version} is available. This Mac build cannot install updates itself yet, so download it from the release page.`;
      }
      return `ZLI ${state.version} is available.`;
    case "downloading":
      return `Downloading ZLI ${state.version}: ${state.percent}%.`;
    case "ready":
      return `ZLI ${state.version} is downloaded. Restart ZLI to finish updating.`;
    case "error":
      return `The last update attempt failed: ${state.message}`;
  }
}

export function lastCheckedText(lastCheckedAt: string | undefined): string {
  if (!lastCheckedAt) return "Not checked yet";
  const date = new Date(lastCheckedAt);
  if (Number.isNaN(date.getTime())) return "Not checked yet";
  return `Last checked ${date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`;
}

export type UpdatePillAction = "restart" | "open-release" | "open-settings";

/** The title bar pill: only for an update that is ready, or one the person has to fetch themselves. */
export function updatePill(status: UpdateStatus | undefined): { label: string; action: UpdatePillAction } | undefined {
  const state = status?.state;
  if (state?.status === "ready") return { label: `Restart to update to v${state.version}`, action: "restart" };
  if (state?.status === "available") {
    return {
      label: `Update available: v${state.version}`,
      action: state.canAutoInstall ? "open-settings" : "open-release",
    };
  }
  return undefined;
}

/** Agents a restart would cut off mid-turn: working, or waiting on the person inside a turn. */
export function busyAgentCount(sessions: readonly { status: string }[]): number {
  return sessions.filter((session) => session.status === "working" || session.status === "waiting").length;
}
