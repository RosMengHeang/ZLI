import type { ProviderDiscovery, ProviderModelOption, ThreadProjection } from "@zli-v2/contracts";

import type { PickerOption } from "../ui/Picker.js";

/** Picker value for sending no level, so the agent uses its own default. */
export const DEFAULT_REASONING = "";

const LABELS: Readonly<Record<string, string>> = {
  off: "Off",
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export function reasoningLabel(level: string): string {
  return LABELS[level.toLowerCase()] ?? level;
}

/**
 * The levels the chat's current model takes. A model's own list wins, then what the session
 * reported when it started, then the agent's list for models that name none.
 */
export function reasoningLevels(
  models: readonly ProviderModelOption[] | undefined,
  model: string | undefined,
  capabilities: ThreadProjection["capabilities"],
  discovery: ProviderDiscovery | undefined,
): { levels: readonly string[]; defaultLevel?: string | undefined } {
  const entry = model ? models?.find((option) => option.id === model) : undefined;
  if (entry?.reasoningEfforts) return { levels: entry.reasoningEfforts, defaultLevel: entry.defaultReasoningEffort };
  if (capabilities.reasoningEfforts?.length) return { levels: capabilities.reasoningEfforts };
  return { levels: discovery?.status === "found" ? (discovery.reasoningEfforts ?? []) : [] };
}

export function reasoningOptions(levels: readonly string[], defaultLevel?: string | undefined): PickerOption<string>[] {
  return [
    {
      value: DEFAULT_REASONING,
      label: defaultLevel ? `Default (${reasoningLabel(defaultLevel)})` : "Default",
      description: "The model's own level",
    },
    ...levels.map((level) => ({ value: level, label: reasoningLabel(level) })),
  ];
}
