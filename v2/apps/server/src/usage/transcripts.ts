import { isBilledModel } from "./pricing.js";

export type UsageProvider = "claude-code" | "codex";

/** One billed model request read from an agent's session log. */
export type UsageEntry = {
  provider: UsageProvider;
  /** Milliseconds since the epoch. */
  at: number;
  model: string;
  /** Uncached input. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** The part of `cacheWrite` kept for an hour, which Anthropic bills higher. */
  cacheWrite1h: number;
  /** Already inside `output`. */
  reasoning: number;
  fast: boolean;
  /** Copies of one request share this key across files; requests without one are counted as they come. */
  key?: string;
};

type Json = Record<string, unknown>;

function record(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function timestamp(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : at;
}

function parse(line: string): Json | undefined {
  try {
    return record(JSON.parse(line));
  } catch {
    return undefined;
  }
}

/** Only lines holding one of these can matter, so the rest are skipped without parsing. */
export const CLAUDE_MARKERS = ['"usage"'] as const;

/**
 * An assistant line of a Claude Code transcript. Claude Code writes one line per content block of a
 * reply, each repeating the reply's usage, and copies earlier replies into resumed and forked sessions;
 * the message id and request id together name the request, so copies merge into one.
 */
export function parseClaudeLine(line: string): UsageEntry[] {
  const row = parse(line);
  if (row?.type !== "assistant") return [];
  const message = record(row.message);
  const usage = record(message?.usage);
  const at = timestamp(row.timestamp);
  const model = text(message?.model);
  if (!message || !usage || at === undefined || !model || !isBilledModel(model)) return [];
  const messageId = text(message.id);
  const requestId = text(row.requestId);
  const key = messageId || requestId ? `claude:${messageId ?? ""}:${requestId ?? ""}` : undefined;
  const fast = usage.speed === "fast";
  const entries = [claudeEntry(model, at, usage, fast, key)];
  // Advisor calls run on another model and are reported only here, each billed at its own model's price.
  const iterations = Array.isArray(usage.iterations) ? usage.iterations : [];
  iterations.forEach((value, index) => {
    const advisor = record(value);
    const advisorModel = text(advisor?.model);
    if (advisor?.type !== "advisor_message" || !advisorModel || !isBilledModel(advisorModel)) return;
    entries.push(claudeEntry(advisorModel, at, advisor, fast, key ? `${key}:advisor:${index}` : undefined));
  });
  return entries;
}

function claudeEntry(model: string, at: number, usage: Json, fast: boolean, key: string | undefined): UsageEntry {
  return {
    provider: "claude-code",
    at,
    model,
    input: count(usage.input_tokens),
    output: count(usage.output_tokens),
    cacheRead: count(usage.cache_read_input_tokens),
    cacheWrite: count(usage.cache_creation_input_tokens),
    cacheWrite1h: count(record(usage.cache_creation)?.ephemeral_1h_input_tokens),
    // Anthropic counts thinking inside output and does not report it apart.
    reasoning: 0,
    fast,
    ...(key ? { key } : {}),
  };
}

export const CODEX_MARKERS = [
  '"token_count"',
  '"token_usage_record"',
  '"turn_context"',
  '"thread_settings_applied"',
  '"session_meta"',
] as const;

type CodexUsage = {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
};
const CODEX_FIELDS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
] as const;

/**
 * What a Codex rollout has said so far that later lines depend on. Codex `token_count` events carry no
 * model, so the model comes from the latest `turn_context` and the service tier from the latest
 * `thread_settings_applied`. Plain data, so it can be kept between reads of a growing file.
 */
export type CodexState = {
  sessionId: string;
  model: string;
  fast: boolean;
  sawMeta: boolean;
  /** The running totals of the last snapshot, to spot a snapshot repeated without a new request. */
  lastTotal: CodexUsage | null;
  lastSignature: string | null;
  /** Set once a turn reports each request by id; its snapshots then only move the baseline. */
  ledger: boolean;
  /** A forked rollout first replays its parent's history, already counted in the parent. */
  forkCopyUntil: number;
};

export function initialCodexState(): CodexState {
  return {
    sessionId: "",
    model: "",
    fast: false,
    sawMeta: false,
    lastTotal: null,
    lastSignature: null,
    ledger: false,
    forkCopyUntil: 0,
  };
}

/** Copied parent history arrives in a burst with gaps of a few milliseconds; real requests are seconds apart. */
const FORK_COPY_GAP_MS = 1_000;

function codexUsage(value: unknown): CodexUsage | undefined {
  const raw = record(value);
  if (!raw || typeof raw.input_tokens !== "number" || typeof raw.output_tokens !== "number") return undefined;
  const usage: CodexUsage = {
    input_tokens: count(raw.input_tokens),
    cached_input_tokens: count(raw.cached_input_tokens),
    cache_write_input_tokens: count(raw.cache_write_input_tokens),
    output_tokens: count(raw.output_tokens),
    reasoning_output_tokens: count(raw.reasoning_output_tokens),
    total_tokens:
      raw.total_tokens === undefined ? count(raw.input_tokens) + count(raw.output_tokens) : count(raw.total_tokens),
  };
  // Cached and written input are parts of input; anything else is a broken line.
  if (usage.cached_input_tokens + usage.cache_write_input_tokens > usage.input_tokens) return undefined;
  return usage;
}

function sameUsage(left: CodexUsage, right: CodexUsage): boolean {
  return CODEX_FIELDS.every((field) => left[field] === right[field]);
}

function isForkCopy(state: CodexState, at: number): boolean {
  if (state.forkCopyUntil === 0) return false;
  if (at < state.forkCopyUntil) {
    state.forkCopyUntil = at + FORK_COPY_GAP_MS;
    return true;
  }
  state.forkCopyUntil = 0;
  state.lastSignature = null;
  return false;
}

function codexEntry(state: CodexState, usage: CodexUsage, at: number, key?: string): UsageEntry {
  return {
    provider: "codex",
    at,
    model: state.model,
    // Codex counts cached and written input inside input_tokens.
    input: usage.input_tokens - usage.cached_input_tokens - usage.cache_write_input_tokens,
    output: usage.output_tokens,
    cacheRead: usage.cached_input_tokens,
    cacheWrite: usage.cache_write_input_tokens,
    cacheWrite1h: 0,
    reasoning: Math.min(usage.reasoning_output_tokens, usage.output_tokens),
    fast: state.fast,
    ...(key ? { key } : {}),
  };
}

/**
 * One line of a Codex rollout. Newer Codex reports each model request in a `token_usage_record` with its
 * response id; that is the count used. Older rollouts have only `token_count` snapshots, whose
 * `last_token_usage` is the latest request; a snapshot whose running total did not move, or that repeats
 * the previous one, is the same request said again and is skipped.
 */
export function parseCodexLine(line: string, state: CodexState): UsageEntry[] {
  const row = parse(line);
  const payload = record(row?.payload);
  if (!row || !payload) return [];
  const at = timestamp(row.timestamp);

  if (row.type === "session_meta") {
    if (state.sawMeta) return [];
    state.sawMeta = true;
    state.sessionId = text(payload.id) ?? text(payload.session_id) ?? "";
    const spawn = record(record(record(payload.source)?.subagent)?.thread_spawn);
    if (at !== undefined && (text(payload.forked_from_id) || text(spawn?.parent_thread_id))) {
      state.forkCopyUntil = at + FORK_COPY_GAP_MS;
    }
    return [];
  }
  if (row.type === "turn_context") {
    const model = text(payload.model);
    if (model) state.model = model;
    state.ledger = false;
    return [];
  }
  if (payload.type === "thread_settings_applied") {
    const tier = record(payload.thread_settings)?.service_tier;
    state.fast = tier === "priority" || tier === "fast";
    return [];
  }
  if (at === undefined || !state.model) return [];

  if (row.type === "token_usage_record") {
    const usage = codexUsage(payload.usage);
    const responseId = text(payload.response_id);
    if (!usage || !responseId || isForkCopy(state, at)) return [];
    state.ledger = true;
    if (usage.input_tokens + usage.output_tokens === 0) return [];
    return [codexEntry(state, usage, at, `codex:${state.sessionId}:${responseId}`)];
  }

  if (payload.type !== "token_count") return [];
  const info = record(payload.info);
  if (!info) return [];
  const last = codexUsage(info.last_token_usage);
  const total = codexUsage(info.total_token_usage) ?? null;
  const previous = state.lastTotal;
  if (total) state.lastTotal = total;
  const signature = last ? JSON.stringify(last) : null;

  if (isForkCopy(state, at) || state.ledger) {
    state.lastSignature = signature;
    return [];
  }
  // Zero requests report the context size after compaction, not a request.
  if (!last || last.input_tokens + last.output_tokens === 0) {
    state.lastSignature = null;
    return [];
  }
  if (total && previous && sameUsage(total, previous)) return [];
  if (!total && signature === state.lastSignature) return [];
  state.lastSignature = signature;
  return [codexEntry(state, last, at)];
}
