import { compactUsage, type ProviderUsage, sumCounts, tokenCount } from "@zli-v2/shared";

export type DroidInbound =
  | { kind: "init"; sessionId: string }
  | { kind: "text"; text: string }
  | { kind: "completion"; isError: boolean; text?: string; usage?: ProviderUsage }
  | { kind: "error"; message: string }
  | { kind: "tool_call"; callId: string; name: string; input?: Record<string, unknown> }
  | { kind: "tool_result"; callId: string; name?: string; isError: boolean; output?: string }
  | { kind: "ignore" }
  | { kind: "invalid"; reason: "init" | "message" };

/**
 * stream-json lines seen from `droid exec`: system/init, message (user echo and
 * assistant text), reasoning, tool_call, tool_result, and completion. Only init,
 * assistant text, completion, and error records change turn state; tool records
 * feed the work log.
 */
/**
 * Each `droid exec` run is one turn, so its completion usage is that turn's. Like Anthropic's API,
 * input_tokens leaves out cache reads and writes, so they are added back. Factory credits are not
 * dollars and are left out.
 */
function completionUsage(value: unknown): ProviderUsage | undefined {
  const usage = asRecord(value);
  if (!usage) return undefined;
  const cacheRead = tokenCount(usage.cache_read_input_tokens);
  return compactUsage({
    inputTokens: sumCounts(tokenCount(usage.input_tokens), tokenCount(usage.cache_creation_input_tokens), cacheRead),
    cachedInputTokens: cacheRead,
    outputTokens: tokenCount(usage.output_tokens),
  });
}

export function classifyDroidMessage(value: unknown): DroidInbound {
  const record = asRecord(value);
  if (!record || typeof record.type !== "string") return { kind: "invalid", reason: "message" };
  switch (record.type) {
    case "system":
      if (record.subtype !== "init") return { kind: "ignore" };
      return typeof record.session_id === "string" && record.session_id.length > 0
        ? { kind: "init", sessionId: record.session_id }
        : { kind: "invalid", reason: "init" };
    case "message": {
      if (record.role !== "assistant") return { kind: "ignore" };
      const text = textValue(record.text);
      return text ? { kind: "text", text } : { kind: "ignore" };
    }
    case "completion": {
      const text = typeof record.finalText === "string" ? record.finalText : undefined;
      const isError =
        record.isError === true ||
        record.is_error === true ||
        (textValue(record.subtype)?.startsWith("error") ?? false);
      const usage = completionUsage(record.usage);
      return { kind: "completion", isError, ...(text === undefined ? {} : { text }), ...(usage ? { usage } : {}) };
    }
    case "error":
      return { kind: "error", message: errorText(record) ?? "Droid CLI reported an error." };
    case "tool_call": {
      const callId = textValue(record.id);
      const name = textValue(record.toolName) ?? textValue(record.toolId);
      if (!callId || !name) return { kind: "ignore" };
      const input = asRecord(record.parameters);
      return { kind: "tool_call", callId, name, ...(input ? { input } : {}) };
    }
    case "tool_result": {
      const callId = textValue(record.id);
      if (!callId) return { kind: "ignore" };
      const name = textValue(record.toolName) ?? textValue(record.toolId);
      const output = resultText(record.value ?? record.result ?? record.error);
      return {
        kind: "tool_result",
        callId,
        isError: record.isError === true || record.is_error === true || exitedWithFailure(output),
        ...(name ? { name } : {}),
        ...(output ? { output } : {}),
      };
    }
    default:
      return { kind: "ignore" };
  }
}

function resultText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/** Execute results end with "[Process exited with code N]"; a non-zero code fails the call whatever isError says. */
function exitedWithFailure(output: string | undefined): boolean {
  const match = output ? /\[Process exited with code (-?\d+)\]\s*$/u.exec(output) : null;
  return match?.[1] !== undefined && match[1] !== "0";
}

function errorText(record: Record<string, unknown>): string | undefined {
  const direct = textValue(record.message) ?? textValue(record.error) ?? textValue(record.text);
  if (direct) return direct;
  const nested = asRecord(record.error);
  return textValue(nested?.message);
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
