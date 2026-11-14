import { z } from "zod";

export const ThreadStartResponse = z.object({
  thread: z.object({ id: z.string().min(1) }).passthrough(),
});
export type ThreadStartResponse = z.infer<typeof ThreadStartResponse>;

export const TurnStartResponse = z.object({
  turn: z.object({ id: z.string().min(1) }).passthrough(),
});
export type TurnStartResponse = z.infer<typeof TurnStartResponse>;

export const ThreadReadResponse = z.object({
  thread: z.object({ id: z.string().min(1), turns: z.array(z.unknown()).optional() }).passthrough(),
});
export type ThreadReadResponse = z.infer<typeof ThreadReadResponse>;

export const ApprovalDecision = z.object({
  decision: z.enum(["accept", "decline", "cancel"]),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

export type CodexToolUpdate = {
  callId: string;
  name: string;
  input?: Record<string, unknown>;
  status: "running" | "completed" | "failed";
  output?: string;
  lines?: { added: number; removed: number };
  /** Pages a webSearch item opened or returned as results. */
  sources?: Array<{ url: string; title?: string }>;
};

const ItemNotification = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  item: z.object({ id: z.string().min(1), type: z.string().min(1) }).passthrough(),
});

/**
 * item/started and item/completed carry the whole item. Tool-like items are
 * commandExecution { command, aggregatedOutput, exitCode }, fileChange
 * { changes: [{ path }] }, mcpToolCall { server, tool, arguments, result, error },
 * webSearch { query }, and imageView { path }. Message and reasoning items are not tools.
 */
export function codexItemTool(
  params: unknown,
  completed: boolean,
): { providerThreadId: string; providerTurnId: string; tool: CodexToolUpdate } | undefined {
  const parsed = ItemNotification.safeParse(params);
  if (!parsed.success) return undefined;
  const { item } = parsed.data;
  const shape = itemShape(item);
  if (!shape) return undefined;
  const status = completed ? completedStatus(item) : "running";
  const output = completed ? itemOutput(item) : undefined;
  const lines = shape.name === "fileChange" && status !== "failed" ? changeLines(item) : undefined;
  const sources = shape.name === "webSearch" ? webSources(item) : [];
  return {
    providerThreadId: parsed.data.threadId,
    providerTurnId: parsed.data.turnId,
    tool: {
      callId: item.id,
      name: shape.name,
      ...(shape.input ? { input: shape.input } : {}),
      status,
      ...(output ? { output } : {}),
      ...(lines ? { lines } : {}),
      ...(sources.length > 0 ? { sources } : {}),
    },
  };
}

/**
 * A reasoning item { id, summary: string[], content: string[] }. summary is the readable summary
 * Codex shows by default; content is the raw reasoning, sent only when the model exposes it.
 */
export function codexReasoningItem(
  params: unknown,
): { providerThreadId: string; providerTurnId: string; itemId: string; text: string } | undefined {
  const parsed = ItemNotification.safeParse(params);
  if (!parsed.success || parsed.data.item.type !== "reasoning") return undefined;
  const { item } = parsed.data;
  const parts = (value: unknown) =>
    Array.isArray(value) ? value.filter((part): part is string => typeof part === "string" && part.length > 0) : [];
  const summary = parts(item.summary);
  return {
    providerThreadId: parsed.data.threadId,
    providerTurnId: parsed.data.turnId,
    itemId: item.id,
    text: (summary.length > 0 ? summary : parts(item.content)).join("\n\n"),
  };
}

const ReasoningDelta = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  itemId: z.string().min(1),
  delta: z.string(),
  summaryIndex: z.number().int().optional(),
  contentIndex: z.number().int().optional(),
});
export type CodexReasoningDelta = z.infer<typeof ReasoningDelta>;

/** item/reasoning/summaryTextDelta, item/reasoning/textDelta, and item/reasoning/summaryPartAdded. */
export function codexReasoningDelta(params: unknown): CodexReasoningDelta | undefined {
  const parsed = ReasoningDelta.safeParse({ delta: "", ...asRecord(params) });
  return parsed.success ? parsed.data : undefined;
}

function webSources(item: Record<string, unknown>): Array<{ url: string; title?: string }> {
  const sources: Array<{ url: string; title?: string }> = [];
  const url = asRecord(item.action)?.url;
  if (typeof url === "string" && url) sources.push({ url });
  if (Array.isArray(item.results)) {
    for (const raw of item.results) {
      const result = asRecord(raw);
      const link = result?.url ?? result?.link;
      if (typeof link !== "string" || !link) continue;
      const title = result?.title;
      sources.push({ url: link, ...(typeof title === "string" && title ? { title } : {}) });
    }
  }
  return sources;
}

function itemShape(item: Record<string, unknown>): { name: string; input?: Record<string, unknown> } | undefined {
  switch (
    String(item.type)
      .toLowerCase()
      .replace(/[^a-z]/gu, "")
  ) {
    case "commandexecution": {
      const command = Array.isArray(item.command)
        ? item.command.filter((part): part is string => typeof part === "string").join(" ")
        : item.command;
      return {
        name: "commandExecution",
        input: {
          ...(typeof command === "string" ? { command } : {}),
          ...(typeof item.cwd === "string" ? { cwd: item.cwd } : {}),
        },
      };
    }
    case "filechange": {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const paths = changes
        .map((change) => asRecord(change)?.path)
        .filter((path): path is string => typeof path === "string" && path.length > 0);
      return { name: "fileChange", input: { paths } };
    }
    case "mcptoolcall": {
      const tool = typeof item.tool === "string" && item.tool ? item.tool : "mcp";
      const server = typeof item.server === "string" && item.server ? `${item.server}.` : "";
      const input = asRecord(item.arguments);
      return { name: `${server}${tool}`, ...(input ? { input } : {}) };
    }
    case "websearch": {
      const action = asRecord(item.action);
      const queries = Array.isArray(action?.queries)
        ? action.queries.filter((query): query is string => typeof query === "string" && query.length > 0)
        : [];
      return {
        name: "webSearch",
        input: {
          ...(typeof item.query === "string" && item.query ? { query: item.query } : {}),
          ...(queries.length > 1 ? { queries } : {}),
          ...(typeof action?.url === "string" && action.url ? { url: action.url } : {}),
          ...(typeof action?.pattern === "string" && action.pattern ? { pattern: action.pattern } : {}),
        },
      };
    }
    case "imageview":
      return { name: "view", input: typeof item.path === "string" ? { path: item.path } : {} };
    default:
      return undefined;
  }
}

/**
 * Lines a fileChange item adds and removes. Each change carries a unified diff for an update and
 * the whole file for an add or a delete.
 */
function changeLines(item: Record<string, unknown>): { added: number; removed: number } | undefined {
  if (!Array.isArray(item.changes)) return undefined;
  let added = 0;
  let removed = 0;
  let counted = false;
  for (const change of item.changes) {
    const record = asRecord(change);
    const diff = typeof record?.diff === "string" ? record.diff : undefined;
    if (diff === undefined) continue;
    counted = true;
    const kind = asRecord(record?.kind)?.type ?? record?.kind;
    const lines = diff.split(/\r?\n/u);
    if (lines.at(-1) === "") lines.pop();
    if (!lines.some((line) => line.startsWith("@@"))) {
      if (kind === "add") added += lines.length;
      else if (kind === "delete") removed += lines.length;
      continue;
    }
    for (const line of lines) {
      if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
      if (line.startsWith("+")) added += 1;
      else if (line.startsWith("-")) removed += 1;
    }
  }
  return counted ? { added, removed } : undefined;
}

function completedStatus(item: Record<string, unknown>): "completed" | "failed" {
  const status = typeof item.status === "string" ? item.status.toLowerCase() : "";
  if (status === "failed" || status === "declined" || status === "error") return "failed";
  if (typeof item.exitCode === "number" && item.exitCode !== 0) return "failed";
  if (item.error !== undefined && item.error !== null) return "failed";
  return "completed";
}

function itemOutput(item: Record<string, unknown>): string | undefined {
  if (typeof item.aggregatedOutput === "string" && item.aggregatedOutput) return item.aggregatedOutput;
  const error = asRecord(item.error);
  if (typeof error?.message === "string" && error.message) return error.message;
  if (typeof item.error === "string" && item.error) return item.error;
  const content = asRecord(item.result)?.content;
  if (Array.isArray(content)) {
    const text = content
      .map((block) => asRecord(block))
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => String(block?.text))
      .join("\n");
    return text || undefined;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
