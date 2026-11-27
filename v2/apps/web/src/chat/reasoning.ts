import { reasoningLabel, reasoningHint } from "@zli-v2/client-runtime";
import type { ProviderModelOption } from "@zli-v2/contracts";

import type { PickerOption } from "../ui/Picker.js";

/** Picker value for sending no level, so the agent uses its own default. */
export const DEFAULT_REASONING = "";

export { reasoningHint, reasoningLabel, reasoningLevels, reasoningNoun } from "@zli-v2/client-runtime";

export function reasoningOptions(levels: readonly string[], defaultLevel?: string | undefined): PickerOption<string>[] {
  return [
    {
      value: DEFAULT_REASONING,
      label: defaultLevel ? `Default (${reasoningLabel(defaultLevel)})` : "Default",
      description: "The model's own level",
    },
    ...levels.map((level) => {
      const hint = reasoningHint(level);
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
