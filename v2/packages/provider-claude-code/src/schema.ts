import { costAmount, sumCounts, tokenCount } from "@zli-v2/shared";

export type ClaudeInbound =
  | { kind: "init"; sessionId: string }
  | { kind: "text"; text: string; partial: boolean; subagent: boolean }
  | { kind: "result"; isError: boolean; text?: string; subtype?: string; usage?: ClaudeResultUsage }
  | {
      kind: "control_request";
      requestId: string;
      subtype: string;
      toolName?: string;
      input?: Record<string, unknown>;
      toolUseId?: string;
    }
  | { kind: "control_response"; requestId: string; ok: boolean; error?: string }
  | { kind: "ignore" }
  | { kind: "invalid"; reason: "init" | "message" };

/** Counts from a result record. Claude's input_tokens leaves out cache reads and writes, so they are added back. */
export type ClaudeResultUsage = {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  /** Running total for the whole session, not this turn. */
  totalCostUsd?: number;
  contextWindow?: number;
};

export function userTurnMessage(
  text: string,
  sessionId: string,
): {
  type: "user";
  session_id: string;
  parent_tool_use_id: null;
  message: { role: "user"; content: string };
} {
  return {
    type: "user",
    session_id: sessionId,
    parent_tool_use_id: null,
    message: { role: "user", content: text },
  };
}

export function initializeRequest(requestId: string): {
  type: "control_request";
  request_id: string;
  request: { subtype: "initialize"; hooks: null };
} {
  return {
    type: "control_request",
    request_id: requestId,
    request: { subtype: "initialize", hooks: null },
  };
}

export function interruptRequest(requestId: string): {
  type: "control_request";
  request_id: string;
  request: { subtype: "interrupt" };
} {
  return {
    type: "control_request",
    request_id: requestId,
    request: { subtype: "interrupt" },
  };
}

export function denyToolRequest(
  requestId: string,
  message = "Claude Code adapter does not support tool approvals.",
): {
  type: "control_response";
  response: {
    subtype: "success";
    request_id: string;
    response: { behavior: "deny"; message: string };
  };
} {
  return {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: requestId,
      response: { behavior: "deny", message },
    },
  };
}

export function allowToolRequest(
  requestId: string,
  input: Record<string, unknown>,
): {
  type: "control_response";
  response: {
    subtype: "success";
    request_id: string;
    response: { behavior: "allow"; updatedInput: Record<string, unknown> };
  };
} {
  return {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: requestId,
      response: { behavior: "allow", updatedInput: input },
    },
  };
}

export function setModelRequest(
  requestId: string,
  model: string,
): { type: "control_request"; request_id: string; request: { subtype: "set_model"; model: string } } {
  return { type: "control_request", request_id: requestId, request: { subtype: "set_model", model } };
}

/** Null clears the override, so the session goes back to the model's default level. */
export function setEffortRequest(
  requestId: string,
  effortLevel: string | null,
): {
  type: "control_request";
  request_id: string;
  request: { subtype: "apply_flag_settings"; settings: { effortLevel: string | null } };
} {
  return {
    type: "control_request",
    request_id: requestId,
    request: { subtype: "apply_flag_settings", settings: { effortLevel } },
  };
}

/** Turns Claude Code's fast mode on or off for the turns that follow. */
export function setFastModeRequest(
  requestId: string,
  fastMode: boolean,
): {
  type: "control_request";
  request_id: string;
  request: { subtype: "apply_flag_settings"; settings: { fastMode: boolean } };
} {
  return {
    type: "control_request",
    request_id: requestId,
    request: { subtype: "apply_flag_settings", settings: { fastMode } },
  };
}

export type ClaudeToolBlock =
  | { kind: "use"; id: string; name: string; input?: Record<string, unknown> }
  | { kind: "result"; toolUseId: string; isError: boolean; output?: string };

/**
 * Tool calls arrive as assistant content blocks { type: "tool_use", id, name, input }
 * and their results as user content blocks { type: "tool_result", tool_use_id, content, is_error }.
 * Subagent traffic carries parent_tool_use_id and stays out of the parent's work log.
 */
export function claudeToolBlocks(value: unknown): ClaudeToolBlock[] {
  const record = asRecord(value);
  if (!record || (record.type !== "assistant" && record.type !== "user") || isSubagent(record)) return [];
  const content = asRecord(record.message)?.content;
  if (!Array.isArray(content)) return [];
  const blocks: ClaudeToolBlock[] = [];
  for (const raw of content) {
    const block = asRecord(raw);
    if (!block) continue;
    if (record.type === "assistant" && block.type === "tool_use") {
      const id = typeof block.id === "string" && block.id ? block.id : undefined;
      const name = typeof block.name === "string" && block.name ? block.name : undefined;
      if (!id || !name) continue;
      const input = asRecord(block.input);
      blocks.push({ kind: "use", id, name, ...(input ? { input } : {}) });
    } else if (record.type === "user" && block.type === "tool_result") {
      const toolUseId = typeof block.tool_use_id === "string" && block.tool_use_id ? block.tool_use_id : undefined;
      if (!toolUseId) continue;
      const output = resultText(block.content);
      blocks.push({ kind: "result", toolUseId, isError: block.is_error === true, ...(output ? { output } : {}) });
    }
  }
  return blocks;
}

export type ClaudeThinking =
  | { kind: "start"; index: number }
  | { kind: "delta"; index: number; text: string }
  | { kind: "stop"; index: number }
  | { kind: "block"; text: string };

/**
 * Thinking in the main conversation. With partial messages it streams as content_block_start
 * { content_block: { type: "thinking" } }, then thinking_delta deltas, then content_block_stop, all at
 * one block index. The assistant record repeats it whole as { type: "thinking", thinking }. A
 * redacted_thinking block has no readable text and is left out.
 */
export function claudeThinking(value: unknown): ClaudeThinking[] {
  const record = asRecord(value);
  if (!record || isSubagent(record)) return [];
  if (record.type === "stream_event") {
    const event = asRecord(record.event);
    const index = typeof event?.index === "number" ? event.index : undefined;
    if (!event || index === undefined) return [];
    if (event.type === "content_block_start") {
      return asRecord(event.content_block)?.type === "thinking" ? [{ kind: "start", index }] : [];
    }
    if (event.type === "content_block_delta") {
      const delta = asRecord(event.delta);
      if (delta?.type !== "thinking_delta" || typeof delta.thinking !== "string" || !delta.thinking) return [];
      return [{ kind: "delta", index, text: delta.thinking }];
    }
    return event.type === "content_block_stop" ? [{ kind: "stop", index }] : [];
  }
  if (record.type !== "assistant") return [];
  const content = asRecord(record.message)?.content;
  if (!Array.isArray(content)) return [];
  const blocks: ClaudeThinking[] = [];
  for (const raw of content) {
    const block = asRecord(raw);
    if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
      blocks.push({ kind: "block", text: block.thinking });
    }
  }
  return blocks;
}

function resultText(content: unknown): string | undefined {
  if (typeof content === "string") return content.length > 0 ? content : undefined;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const raw of content) {
    const block = asRecord(raw);
    if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

export function unsupportedControlResponse(requestId: string): {
  type: "control_response";
  response: { subtype: "error"; request_id: string; error: string };
} {
  return {
    type: "control_response",
    response: {
      subtype: "error",
      request_id: requestId,
      error: "Unsupported Claude Code control request.",
    },
  };
}

export function classifyClaudeMessage(value: unknown): ClaudeInbound {
  const record = asRecord(value);
  if (!record || typeof record.type !== "string") return { kind: "invalid", reason: "message" };
  if (record.type === "system" && record.subtype === "init") {
    return typeof record.session_id === "string" && record.session_id.length > 0
      ? { kind: "init", sessionId: record.session_id }
      : { kind: "invalid", reason: "init" };
  }
  if (record.type === "stream_event") {
    const text = textDelta(record.event);
    return text === undefined
      ? { kind: "ignore" }
      : { kind: "text", text, partial: true, subagent: isSubagent(record) };
  }
  if (record.type === "assistant") {
    const text = textFromContent(asRecord(record.message)?.content);
    return text === undefined
      ? { kind: "ignore" }
      : { kind: "text", text, partial: false, subagent: isSubagent(record) };
  }
  if (record.type === "result") {
    const subtype = typeof record.subtype === "string" ? record.subtype : undefined;
    const text = typeof record.result === "string" ? record.result : undefined;
    const usage = resultUsage(record);
    return {
      kind: "result",
      isError: record.is_error === true || (subtype?.startsWith("error") ?? false),
      ...(text === undefined ? {} : { text }),
      ...(subtype === undefined ? {} : { subtype }),
      ...(usage ? { usage } : {}),
    };
  }
  if (record.type === "control_request") return classifyControlRequest(record);
  if (record.type === "control_response") return classifyControlResponse(record);
  return { kind: "ignore" };
}

function resultUsage(record: Record<string, unknown>): ClaudeResultUsage | undefined {
  const usage = asRecord(record.usage);
  const cacheRead = tokenCount(usage?.cache_read_input_tokens);
  const windows = Object.values(asRecord(record.modelUsage) ?? {})
    .map((entry) => tokenCount(asRecord(entry)?.contextWindow))
    .filter((value): value is number => value !== undefined && value > 0);
  return compactClaudeUsage({
    inputTokens: sumCounts(tokenCount(usage?.input_tokens), tokenCount(usage?.cache_creation_input_tokens), cacheRead),
    cachedInputTokens: cacheRead,
    outputTokens: tokenCount(usage?.output_tokens),
    totalCostUsd: costAmount(record.total_cost_usd),
    contextWindow: windows.length > 0 ? Math.max(...windows) : undefined,
  });
}

function compactClaudeUsage(
  usage: {
    [K in keyof ClaudeResultUsage]: number | undefined;
  },
): ClaudeResultUsage | undefined {
  const result: ClaudeResultUsage = {};
  for (const [key, value] of Object.entries(usage) as Array<[keyof ClaudeResultUsage, number | undefined]>) {
    if (value !== undefined) result[key] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * The prompt size of the model's latest call in the main conversation, which is how full its
 * context window is. Subagents have their own context and are left out.
 */
export function claudeContextTokens(value: unknown): number | undefined {
  const record = asRecord(value);
  if (record?.type !== "assistant" || isSubagent(record)) return undefined;
  const usage = asRecord(asRecord(record.message)?.usage);
  if (!usage) return undefined;
  return sumCounts(
    tokenCount(usage.input_tokens),
    tokenCount(usage.cache_creation_input_tokens),
    tokenCount(usage.cache_read_input_tokens),
    tokenCount(usage.output_tokens),
  );
}

/**
 * A main-conversation request starting, read from its `message_start` stream event. A request
 * refreshes the prompt cache, which then lives for `ttlMs` from the request's start. `ttlMs` is
 * set only when the request wrote to the cache, since that is the only place the tier shows.
 */
export function claudeCacheRequest(value: unknown): { ttlMs?: number } | undefined {
  const record = asRecord(value);
  if (record?.type !== "stream_event" || isSubagent(record)) return undefined;
  const event = asRecord(record.event);
  if (event?.type !== "message_start") return undefined;
  const creation = asRecord(asRecord(asRecord(event.message)?.usage)?.cache_creation);
  if ((tokenCount(creation?.ephemeral_1h_input_tokens) ?? 0) > 0) return { ttlMs: 60 * 60_000 };
  if ((tokenCount(creation?.ephemeral_5m_input_tokens) ?? 0) > 0) return { ttlMs: 5 * 60_000 };
  return {};
}

/**
 * What a message says about the plan's usage limit. "blocked" means Claude refused the request until
 * the limit resets; "clear" means a limit report allowed it. A `rate_limit_event` reports it, and an
 * assistant record that Claude answered with `error: "rate_limit"` repeats it. Extra usage that is
 * allowed means the request still runs, so that does not count as blocked.
 */
export function claudeUsageLimit(
  value: unknown,
): { state: "blocked"; resetsAt?: string } | { state: "clear" } | undefined {
  const record = asRecord(value);
  let info: Record<string, unknown> | undefined;
  if (record?.type === "rate_limit_event") info = asRecord(record.rate_limit_info);
  else if (record?.type === "assistant" && record.error === "rate_limit" && !isSubagent(record))
    info = asRecord(asRecord(record.api_error_params)?.rate_limit_info) ?? { status: "rejected" };
  if (!info) return undefined;
  const overage =
    info.overageStatus === "allowed" ||
    info.overageStatus === "allowed_warning" ||
    info.isUsingOverage === true ||
    info.overageInUse === true;
  if (info.status === "rejected" && !overage) {
    const resetMs = typeof info.resetsAt === "number" ? info.resetsAt * 1000 : Number.NaN;
    return Number.isFinite(resetMs) && resetMs > 0 && resetMs < 8.64e15
      ? { state: "blocked", resetsAt: new Date(resetMs).toISOString() }
      : { state: "blocked" };
  }
  return info.status === "allowed" || info.status === "allowed_warning" || overage ? { state: "clear" } : undefined;
}

function classifyControlRequest(record: Record<string, unknown>): ClaudeInbound {
  const request = asRecord(record.request);
  const requestId = typeof record.request_id === "string" ? record.request_id : "";
  const subtype = typeof request?.subtype === "string" ? request.subtype : "";
  if (!requestId || !subtype) return { kind: "invalid", reason: "message" };
  const toolName = typeof request?.tool_name === "string" && request.tool_name ? request.tool_name : undefined;
  const input = asRecord(request?.input);
  const toolUseId = typeof request?.tool_use_id === "string" && request.tool_use_id ? request.tool_use_id : undefined;
  return {
    kind: "control_request",
    requestId,
    subtype,
    ...(toolName ? { toolName } : {}),
    ...(input ? { input } : {}),
    ...(toolUseId ? { toolUseId } : {}),
  };
}

function classifyControlResponse(record: Record<string, unknown>): ClaudeInbound {
  const response = asRecord(record.response);
  const requestId = typeof response?.request_id === "string" ? response.request_id : "";
  if (!requestId) return { kind: "ignore" };
  if (response?.subtype === "error") {
    const error = typeof response.error === "string" ? response.error : "Claude Code rejected a control request.";
    return { kind: "control_response", requestId, ok: false, error };
  }
  return { kind: "control_response", requestId, ok: true };
}

function textDelta(value: unknown): string | undefined {
  const delta = asRecord(asRecord(value)?.delta);
  if (delta?.type !== "text_delta" || typeof delta.text !== "string" || delta.text.length === 0) return undefined;
  return delta.text;
}

function textFromContent(content: unknown): string | undefined {
  if (typeof content === "string" && content.length > 0) return content;
  if (!Array.isArray(content)) return undefined;
  let text = "";
  for (const block of content) {
    const record = asRecord(block);
    if (record?.type === "text" && typeof record.text === "string") text += record.text;
  }
  return text.length > 0 ? text : undefined;
}

function isSubagent(record: Record<string, unknown>): boolean {
  return record.parent_tool_use_id !== undefined && record.parent_tool_use_id !== null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
