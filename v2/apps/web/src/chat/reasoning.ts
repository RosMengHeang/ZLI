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

/**
 * What each agent calls it: Claude Code sets an effort level, Codex a reasoning level. Other agents read
 * as reasoning.
 */
export function reasoningNoun(provider: string | undefined): string {
  return provider === "claude-code" ? "Effort" : "Reasoning";
}

/** One line on what a level trades, so a pick says more than a word. Unknown levels show none. */
const LEVEL_HINTS: Readonly<Record<string, string>> = {
  off: "Answers straight away",
  none: "Answers straight away",
  minimal: "Barely thinks. Fastest",
  low: "Quick answers for small tasks",
  medium: "Balanced for everyday work",
  high: "Thinks longer on hard problems",
  xhigh: "Thinks the longest. Slower",
  max: "No limit on thinking. Slowest",
};

export function reasoningHint(level: string | undefined): string | undefined {
  return level ? LEVEL_HINTS[level.toLowerCase()] : undefined;
}

export function reasoningOptions(levels: readonly string[], defaultLevel?: string | undefined): PickerOption<string>[] {
  return [
    {
      value: DEFAULT_REASONING,
      label: defaultLevel ? `Default (${reasoningLabel(defaultLevel)})` : "Default",
      description: "The model's own level",
    },
    ...levels.map((level) => {
      const hint = LEVEL_HINTS[level.toLowerCase()];
      return { value: level, label: reasoningLabel(level), ...(hint ? { description: hint } : {}) };
    }),
  ];
}

/**
 * What a turn sends to run the picked model in its faster mode, or undefined when it has none. With no model
 * picked, the agent's own default model decides.
 */
export function fastFor(
  models: readonly ProviderModelOption[] | undefined,
  model: string | undefined,
): string | undefined {
  const picked = model ? models?.find((option) => option.id === model) : models?.find((option) => option.isDefault);
  return picked?.fast;
}
