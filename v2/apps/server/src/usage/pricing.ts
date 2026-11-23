/**
 * List prices per model, in US dollars per million tokens.
 *
 * Source: the published API price pages of Anthropic (https://platform.claude.com/docs/en/about-claude/pricing)
 * and OpenAI (https://openai.com/api/pricing), as collected in LiteLLM's model_prices_and_context_window.json
 * (https://github.com/BerriAI/litellm), checked 2026-11-21. Anthropic models retired before that list
 * (Claude 3 and 4.0/4.1) use the prices Anthropic published while they were served.
 *
 * These are pay-as-you-go API prices. On a subscription plan nothing is billed per token, so the cost
 * reads as what the same work would cost through the API. A model missing here is counted in tokens and
 * its cost shows as unknown; nothing is guessed.
 */
export type ModelPrice = {
  input: number;
  output: number;
  cacheRead: number;
  /** Anthropic's 5-minute cache write; OpenAI's cache write where it bills one, else the input price. */
  cacheWrite: number;
  /** Anthropic's 1-hour cache write. */
  cacheWrite1h?: number;
  /** Fast mode (Claude) or the priority tier (OpenAI) bills every token at this multiple. */
  fast?: number;
  /** A request whose prompt is longer than `above` tokens bills input and cache at `inputX`, output at `outputX`. */
  longContext?: { above: number; inputX: number; outputX: number };
};

/** Anthropic: cache writes are 1.25x input (5 minutes) and 2x (1 hour); reads are a per-model fraction. */
function claude(input: number, output: number, cacheRead: number, extra: Partial<ModelPrice> = {}): ModelPrice {
  return { input, output, cacheRead, cacheWrite: input * 1.25, cacheWrite1h: input * 2, ...extra };
}

/** OpenAI: cached input reads at the given rate; writes, where billed, are 1.25x input. */
function openai(input: number, output: number, cacheRead: number, extra: Partial<ModelPrice> = {}): ModelPrice {
  return { input, output, cacheRead, cacheWrite: input, ...extra };
}

const OPENAI_LONG = { above: 272_000, inputX: 2, outputX: 1.5 };
/** The GPT-6 and 5.6 families bill cache writes and double input past 272K tokens; priority is 2x. */
function gpt6(input: number, output: number, cacheRead: number): ModelPrice {
  return openai(input, output, cacheRead, { cacheWrite: input * 1.25, fast: 2, longContext: OPENAI_LONG });
}

export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  // Anthropic
  "claude-fable-5-2": claude(8, 40, 0.2, { fast: 2 }),
  "claude-mythos-5-2": claude(8, 40, 0.2, { fast: 2 }),
  "claude-fable-5-1": claude(10, 50, 0.25),
  "claude-mythos-5-1": claude(10, 50, 0.25),
  "claude-fable-5": claude(10, 50, 1),
  "claude-mythos-5": claude(10, 50, 1),
  "claude-opus-5-5": claude(4, 20, 0.2, { fast: 2 }),
  "claude-opus-5": claude(5, 25, 0.5, { fast: 2 }),
  "claude-opus-4-8": claude(5, 25, 0.5, { fast: 2 }),
  "claude-opus-4-7": claude(5, 25, 0.5),
  "claude-opus-4-6": claude(5, 25, 0.5),
  "claude-opus-4-5": claude(5, 25, 0.5),
  "claude-opus-4-1": claude(15, 75, 1.5),
  "claude-opus-4": claude(15, 75, 1.5),
  "claude-sonnet-5-5": claude(2, 10, 0.1),
  "claude-sonnet-5": claude(2, 10, 0.2),
  "claude-sonnet-4-6": claude(3, 15, 0.3),
  "claude-sonnet-4-5": claude(3, 15, 0.3, { longContext: { above: 200_000, inputX: 2, outputX: 1.5 } }),
  "claude-sonnet-4": claude(3, 15, 0.3, { longContext: { above: 200_000, inputX: 2, outputX: 1.5 } }),
  "claude-3-7-sonnet": claude(3, 15, 0.3),
  "claude-3-5-sonnet": claude(3, 15, 0.3),
  "claude-haiku-5-5": claude(0.1, 0.5, 0.01, { longContext: { above: 100_000, inputX: 5, outputX: 5 } }),
  "claude-haiku-4-5": claude(1, 5, 0.1),
  "claude-3-5-haiku": claude(0.8, 4, 0.08),
  "claude-3-haiku": { input: 0.25, output: 1.25, cacheRead: 0.03, cacheWrite: 0.3 },
  "claude-3-opus": claude(15, 75, 1.5),
  // OpenAI
  "gpt-6.2-astra": gpt6(8, 40, 0.4),
  "gpt-6.2-sol": gpt6(2, 10, 0.1),
  "gpt-6.1-sol": gpt6(2, 10, 0.1),
  "gpt-6.1-terra": gpt6(1, 5, 0.05),
  "gpt-6-astra": gpt6(10, 50, 1),
  "gpt-6-sol": gpt6(2, 10, 0.2),
  "gpt-6-luna": gpt6(0.1, 0.5, 0.01),
  "gpt-5.6": gpt6(4, 20, 0.4),
  "gpt-5.6-sol": gpt6(4, 20, 0.4),
  "gpt-5.6-terra": gpt6(2, 12, 0.2),
  "gpt-5.6-luna": gpt6(0.2, 1.2, 0.02),
  "gpt-5.5": openai(5, 30, 0.5, { fast: 2.5, longContext: OPENAI_LONG }),
  "gpt-5.4": openai(2.5, 15, 0.25, { fast: 2, longContext: { above: 272_000, inputX: 2, outputX: 1.5 } }),
  "gpt-5.4-mini": openai(0.75, 4.5, 0.075, { fast: 2 }),
  "gpt-5.4-nano": openai(0.2, 1.25, 0.02),
  "gpt-5.3-codex": openai(1.75, 14, 0.175, { fast: 2 }),
  "gpt-5.2": openai(1.75, 14, 0.175, { fast: 2 }),
  "gpt-5.2-codex": openai(1.75, 14, 0.175),
  "gpt-5.1": openai(1.25, 10, 0.125, { fast: 2 }),
  "gpt-5.1-codex": openai(1.25, 10, 0.125),
  "gpt-5.1-codex-max": openai(1.25, 10, 0.125),
  "gpt-5.1-codex-mini": openai(0.25, 2, 0.025),
  "gpt-5": openai(1.25, 10, 0.125, { fast: 2 }),
  "gpt-5-codex": openai(1.25, 10, 0.125),
  "gpt-5-mini": openai(0.25, 2, 0.025, { fast: 1.8 }),
  "gpt-5-nano": openai(0.05, 0.4, 0.005),
  o3: openai(2, 8, 0.5, { fast: 1.75 }),
  "o4-mini": openai(1.1, 4.4, 0.275),
};

/** Names an agent logs that never reached a billed model, such as Claude Code's local placeholders. */
const UNBILLED = new Set(["<synthetic>", "synthetic"]);

/**
 * The price row for a logged model name. Claude Code logs dated ids ("claude-haiku-4-5-20251001") and
 * context variants ("claude-opus-4-6[1m]"); a provider prefix ("anthropic/", "openai/") may come first.
 */
export function priceFor(model: string): ModelPrice | undefined {
  const name = normalizeModel(model);
  if (!name || UNBILLED.has(name)) return undefined;
  return (
    MODEL_PRICES[name] ??
    MODEL_PRICES[name.replace(/-\d{8}$/u, "")] ??
    MODEL_PRICES[name.replace(/-\d{4}-\d{2}-\d{2}$/u, "")]
  );
}

export function normalizeModel(model: string): string {
  let name = model.trim().toLowerCase();
  const bracket = name.indexOf("[");
  if (bracket !== -1) name = name.slice(0, bracket);
  const slash = name.lastIndexOf("/");
  if (slash !== -1) name = name.slice(slash + 1);
  return name;
}

export function isBilledModel(model: string): boolean {
  const name = normalizeModel(model);
  return name.length > 0 && !UNBILLED.has(name);
}

export type PricedTokens = {
  /** Uncached input. */
  input: number;
  output: number;
  cacheRead: number;
  /** All cache writes, of which `cacheWrite1h` were written for an hour. */
  cacheWrite: number;
  cacheWrite1h: number;
  fast: boolean;
};

/** The list cost of one request in dollars, or undefined when the model has no price. */
export function requestCost(model: string, tokens: PricedTokens): number | undefined {
  const price = priceFor(model);
  if (!price) return undefined;
  const prompt = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  const long = price.longContext && prompt > price.longContext.above ? price.longContext : undefined;
  const inputX = long?.inputX ?? 1;
  const outputX = long?.outputX ?? 1;
  const speedX = tokens.fast ? (price.fast ?? 1) : 1;
  const oneHour = Math.min(tokens.cacheWrite1h, tokens.cacheWrite);
  const perMillion =
    (tokens.input * price.input +
      tokens.cacheRead * price.cacheRead +
      (tokens.cacheWrite - oneHour) * price.cacheWrite +
      oneHour * (price.cacheWrite1h ?? price.cacheWrite)) *
      inputX +
    tokens.output * price.output * outputX;
  return (perMillion * speedX) / 1_000_000;
}
