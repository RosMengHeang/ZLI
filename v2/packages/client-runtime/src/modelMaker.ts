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
