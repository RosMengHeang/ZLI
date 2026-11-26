import type { BuddyEngine, BuddyQuality, ProviderDiscovery, ProviderKind } from "@zli-v2/contracts";

import { AgentModelPicker } from "../chat/AgentModelPicker.js";
import { otherAgents } from "../chat/agentModels.js";

/** Auto's three levels, from cheapest to strongest. */
export const QUALITY_LEVELS: readonly { value: BuddyQuality; label: string; description: string }[] = [
  { value: "save", label: "Budget", description: "The cheapest model that can do the job" },
  { value: "balanced", label: "Balanced", description: "The model each job needs" },
  { value: "best", label: "Best", description: "Stronger models, even for small jobs" },
];

/**
 * Which model a buddy runs, in the same picker the chat uses: Auto first, at one of its levels, then each agent
 * and its models. A buddy without its own Auto level shows the team's.
 */
export function BuddyModelPicker({
  engine,
  providers,
  teamQuality,
  onChange,
  field = false,
}: {
  engine: BuddyEngine;
  providers: readonly ProviderDiscovery[];
  teamQuality: BuddyQuality;
  onChange(engine: BuddyEngine): void;
  /** Full width like a form field; otherwise a quiet trigger like the chat's. */
  field?: boolean;
}) {
  const current = engine.mode === "auto" ? undefined : engine.provider;
  const discovery = providers.find((entry) => entry.provider === current);
  const lock = (provider: string, model: string | undefined) =>
    onChange({ mode: "locked", provider: provider as ProviderKind, ...(model ? { model } : {}) });
  return (
    <AgentModelPicker
      provider={current}
      agentName={discovery?.displayName ?? current ?? "Auto"}
      models={discovery?.status === "found" ? discovery.models : undefined}
      model={engine.mode === "locked" ? engine.model : undefined}
      others={otherAgents(providers, current ?? "")}
      locked={false}
      tooltip="Auto, or the agent and model this buddy always runs"
      onModelChange={(model) => current && lock(current, model)}
      onAgentChange={(provider, model) => lock(provider, model)}
      auto={{
        levels: QUALITY_LEVELS,
        value: engine.mode === "auto" ? (engine.quality ?? teamQuality) : undefined,
        onPick: (quality) => onChange({ mode: "auto", quality: quality as BuddyQuality }),
      }}
      prefer="below"
      field={field}
    />
  );
}
