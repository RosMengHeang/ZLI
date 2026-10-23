import type { ProviderModelOption } from "@zli-v2/contracts";

import { Icon } from "./Icon.js";
import type { PickerOption } from "./Picker.js";
import { ProviderMark } from "./ProviderMark.js";

/** The picker's value for the agent's own default model; real model ids are never empty. */
export const DEFAULT_MODEL = "";

/**
 * Model ids carry their maker's name in many shapes ("claude-sonnet-4-5", "openai/gpt-5",
 * "openrouter/x-ai/grok-4"), so the maker is found by name fragments. Order matters: a routed id
 * such as "github-copilot/claude-sonnet-4" must match Claude before anything generic.
 */
const MAKERS: readonly (readonly [RegExp, string])[] = [
  [/claude|anthropic|opus|sonnet|haiku/u, "claude-code"],
  [/gemini|gemma|google/u, "gemini"],
  [/grok|x-ai|xai/u, "xai"],
  [/glm|z-ai|zai|zhipu/u, "zai"],
  [/kimi|moonshot/u, "kimi"],
  [/qwen|qwq|alibaba/u, "qwen"],
  [/deepseek/u, "deepseek"],
  [/mistral|devstral|codestral|magistral/u, "mistral"],
  [/llama|meta-/u, "meta"],
  [/minimax/u, "minimax"],
  [/gpt|openai|codex|(^|[/\s-])o[1-4](-|\s|$)/u, "openai"],
  [/composer|cursor/u, "cursor-agent"],
];

/** The mark key of the company that makes a model, or undefined when the id does not say. */
export function modelMaker(id: string, label?: string | undefined): string | undefined {
  const name = `${id} ${label ?? ""}`.toLowerCase();
  return MAKERS.find(([pattern]) => pattern.test(name))?.[1];
}

/** The maker's logo for a model, or a neutral chip glyph for the default or an unknown model. */
export function ModelMark({
  id,
  label,
  size = 14,
}: {
  id: string | undefined;
  label?: string | undefined;
  size?: number;
}) {
  const maker = id ? modelMaker(id, label) : undefined;
  return maker ? (
    <ProviderMark provider={maker} size={size} />
  ) : (
    <Icon name="cpu" size={size} className="model-mark-generic" />
  );
}

/**
 * Picker options for a model choice: the agent's default first, then a chosen model the agent no
 * longer lists, then the listed models, each with its maker's logo.
 */
export function modelOptions(
  models: readonly ProviderModelOption[] | undefined,
  current: string | undefined,
): PickerOption<string>[] {
  const listed = models ?? [];
  const options: PickerOption<string>[] = [
    { value: DEFAULT_MODEL, label: "Default model", icon: <ModelMark id={undefined} size={15} /> },
  ];
  if (current && !listed.some((option) => option.id === current))
    options.push({ value: current, label: current, icon: <ModelMark id={current} size={15} /> });
  for (const option of listed)
    options.push({
      value: option.id,
      label: option.label,
      icon: <ModelMark id={option.id} label={option.label} size={15} />,
    });
  return options;
}
