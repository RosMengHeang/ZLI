import { compactUsage, costAmount, type ProviderUsage, tokenCount } from "@zli-v2/shared";
import { z } from "zod";

import { parseConfigOptions, type SessionConfigOption } from "./protocol.js";

export type AcpToolStatus = "running" | "completed" | "failed";

/** One tool call as ZLI tracks it. `name` is a classifier-friendly tool name derived from the ACP kind. */
export type AcpToolUpdate = {
  callId: string;
  name: string;
  title?: string;
  input?: Record<string, unknown>;
  status: AcpToolStatus;
  output?: string;
  lines?: { added: number; removed: number };
};

/** Fields a tool_call or tool_call_update may carry. Updates only send what changed. */
export type AcpToolFields = {
  title?: string;
  kind?: string;
  status?: AcpToolStatus;
  paths?: string[];
  rawInput?: Record<string, unknown>;
  output?: string;
  lines?: { added: number; removed: number };
};

export type AcpSessionUpdate =
  | { kind: "text"; text: string }
  | { kind: "tool"; toolCallId: string; fields: AcpToolFields }
  | { kind: "config"; configOptions: SessionConfigOption[] }
  /** totalCostUsd is the session's running total, not this turn's. */
  | { kind: "usage"; usage: ProviderUsage; totalCostUsd?: number }
  | { kind: "ignore" }
  | { kind: "invalid" };

const SessionNotification = z
  .object({
    sessionId: z.string().min(1),
    update: z.object({ sessionUpdate: z.string().min(1) }).passthrough(),
  })
  .passthrough();

const MAX_OUTPUT_CHARS = 20_000;

export function parseSessionNotification(params: unknown): { sessionId: string; update: AcpSessionUpdate } | undefined {
  const parsed = SessionNotification.safeParse(params);
  if (!parsed.success) return undefined;
  return { sessionId: parsed.data.sessionId, update: classifySessionUpdate(parsed.data.update) };
}

/**
 * Only assistant text, tool calls, and config changes affect ZLI. Thoughts, plans,
 * command lists, mode changes, and user echoes are ignored.
 */
export function classifySessionUpdate(update: Record<string, unknown>): AcpSessionUpdate {
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const content = asRecord(update.content);
      if (content?.type !== "text" || typeof content.text !== "string") return { kind: "ignore" };
      return content.text.length > 0 ? { kind: "text", text: content.text } : { kind: "ignore" };
    }
    case "tool_call":
    case "tool_call_update": {
      const toolCallId = textValue(update.toolCallId);
      if (!toolCallId) return { kind: "invalid" };
      return { kind: "tool", toolCallId, fields: toolFields(update) };
    }
    case "config_option_update":
      return { kind: "config", configOptions: parseConfigOptions(update.configOptions) };
    case "usage_update": {
      const cost = asRecord(update.cost);
      const totalCostUsd =
        typeof cost?.currency === "string" && cost.currency.toUpperCase() === "USD"
          ? costAmount(cost.amount)
          : undefined;
      const usage = compactUsage({ contextTokens: tokenCount(update.used), contextWindow: tokenCount(update.size) });
      if (!usage && totalCostUsd === undefined) return { kind: "ignore" };
      return { kind: "usage", usage: usage ?? {}, ...(totalCostUsd === undefined ? {} : { totalCostUsd }) };
    }
    default:
      return { kind: "ignore" };
  }
}

/** Token counts some agents add to a session/prompt response. Cache reads are part of the input. */
export function promptUsage(result: unknown): ProviderUsage | undefined {
  const usage = asRecord(asRecord(result)?.usage);
  if (!usage) return undefined;
  const inputTokens = tokenCount(usage.inputTokens);
  const cached = tokenCount(usage.cachedReadTokens);
  return compactUsage({
    inputTokens,
    cachedInputTokens: cached === undefined || inputTokens === undefined ? cached : Math.min(cached, inputTokens),
    outputTokens: tokenCount(usage.outputTokens),
  });
}

export function toolFields(update: Record<string, unknown>): AcpToolFields {
  const title = textValue(update.title);
  const kind = textValue(update.kind);
  const status = toolStatus(update.status);
  const rawInput = asRecord(update.rawInput);
  const paths = [...locationPaths(update.locations), ...diffPaths(update.content)];
  const output = contentText(update.content) ?? rawOutputText(update.rawOutput);
  const lines = diffLines(update.content);
  return {
    ...(title ? { title } : {}),
    ...(kind ? { kind } : {}),
    ...(status ? { status } : {}),
    ...(paths.length > 0 ? { paths: [...new Set(paths)] } : {}),
    ...(rawInput ? { rawInput } : {}),
    ...(output ? { output } : {}),
    ...(lines ? { lines } : {}),
  };
}

export function mergeToolFields(previous: AcpToolFields | undefined, next: AcpToolFields): AcpToolFields {
  if (!previous) return next;
  const paths = [...new Set([...(previous.paths ?? []), ...(next.paths ?? [])])];
  return { ...previous, ...next, ...(paths.length > 0 ? { paths } : {}) };
}

const KIND_NAMES: Readonly<Record<string, string>> = {
  read: "Read",
  edit: "Edit",
  delete: "Delete",
  // A move changes files on disk, so it reads best as an edit of its paths.
  move: "Edit",
  search: "Search",
  execute: "Execute",
  fetch: "Fetch",
  think: "Think",
};

export function acpToolUpdate(callId: string, fields: AcpToolFields): AcpToolUpdate {
  const name = (fields.kind ? KIND_NAMES[fields.kind] : undefined) ?? fields.title ?? "Tool";
  const input: Record<string, unknown> = {
    ...(fields.rawInput ?? {}),
    ...(fields.paths && fields.paths.length > 0 ? { paths: fields.paths } : {}),
  };
  return {
    callId,
    name,
    ...(fields.title ? { title: fields.title } : {}),
    ...(Object.keys(input).length > 0 ? { input } : {}),
    status: fields.status ?? "running",
    ...(fields.output ? { output: fields.output } : {}),
    ...(fields.lines ? { lines: fields.lines } : {}),
  };
}

function toolStatus(value: unknown): AcpToolStatus | undefined {
  switch (value) {
    case "pending":
    case "in_progress":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return undefined;
  }
}

function locationPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const path = textValue(asRecord(item)?.path);
    return path ? [path] : [];
  });
}

function diffPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    const path = record?.type === "diff" ? textValue(record.path) : undefined;
    return path ? [path] : [];
  });
}

/** Lines changed across the call's diff blocks, after the lines both sides share at each end. */
function diffLines(value: unknown): { added: number; removed: number } | undefined {
  if (!Array.isArray(value)) return undefined;
  let total: { added: number; removed: number } | undefined;
  for (const item of value) {
    const record = asRecord(item);
    if (record?.type !== "diff" || typeof record.newText !== "string") continue;
    const before = splitLines(typeof record.oldText === "string" ? record.oldText : "");
    const after = splitLines(record.newText);
    let start = 0;
    while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
    let endBefore = before.length;
    let endAfter = after.length;
    while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
      endBefore -= 1;
      endAfter -= 1;
    }
    total = {
      added: (total?.added ?? 0) + endAfter - start,
      removed: (total?.removed ?? 0) + endBefore - start,
    };
  }
  return total;
}

function splitLines(value: string): string[] {
  if (value.length === 0) return [];
  const lines = value.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function contentText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts = value.flatMap((item) => {
    const record = asRecord(item);
    if (record?.type !== "content") return [];
    const block = asRecord(record.content);
    return block?.type === "text" && typeof block.text === "string" && block.text.length > 0 ? [block.text] : [];
  });
  return parts.length > 0 ? clip(parts.join("\n")) : undefined;
}

function rawOutputText(value: unknown): string | undefined {
  if (typeof value === "string") return value.length > 0 ? clip(value) : undefined;
  const record = asRecord(value);
  if (!record) return undefined;
  for (const key of ["output", "stdout", "result", "error", "message"]) {
    const text = record[key];
    if (typeof text === "string" && text.length > 0) return clip(text);
  }
  try {
    const json = JSON.stringify(record);
    return json === "{}" ? undefined : clip(json);
  } catch {
    return undefined;
  }
}

function clip(value: string): string {
  return value.length > MAX_OUTPUT_CHARS ? value.slice(-MAX_OUTPUT_CHARS) : value;
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
