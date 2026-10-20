export const CURSOR_TOOL_DENY_MESSAGE = "Cursor CLI denied a tool call, which this adapter does not approve.";

export type CursorToolUpdate = {
  callId: string;
  name: string;
  input?: Record<string, unknown>;
  status: "running" | "completed" | "failed";
  output?: string;
};

export type CursorInbound =
  | { kind: "init"; sessionId: string }
  | { kind: "tool"; tool?: CursorToolUpdate; denied: boolean }
  | { kind: "text"; text: string; partial: boolean }
  | { kind: "result"; isError: boolean; text?: string; subtype?: string }
  | { kind: "tool_denied"; message: string }
  | { kind: "ignore" }
  | { kind: "invalid"; reason: "init" | "message" };

export function classifyCursorMessage(value: unknown): CursorInbound {
  const record = asRecord(value);
  if (!record || typeof record.type !== "string") return { kind: "invalid", reason: "message" };
  if (record.type === "system" && record.subtype === "init") {
    return typeof record.session_id === "string" && record.session_id.length > 0
      ? { kind: "init", sessionId: record.session_id }
      : { kind: "invalid", reason: "init" };
  }
  if (record.type === "tool_call") return classifyToolCall(record);
  const denial = denialMessage(record);
  if (denial) return { kind: "tool_denied", message: denial };
  if (record.type === "assistant") return classifyAssistant(record);
  if (record.type === "result") return classifyResult(record);
  return { kind: "ignore" };
}

function denialMessage(record: Record<string, unknown>): string | undefined {
  if (record.type === "permission" || record.type === "permission_request" || record.type === "tool_request") {
    return CURSOR_TOOL_DENY_MESSAGE;
  }
  if (record.type === "control_request") {
    const request = asRecord(record.request);
    const subtype = textValue(request?.subtype) ?? textValue(record.subtype) ?? "";
    if (subtype === "can_use_tool" || subtype === "permission" || subtype === "request_approval") {
      return CURSOR_TOOL_DENY_MESSAGE;
    }
    return undefined;
  }
  return undefined;
}

const TOOL_CALL_METADATA = new Set(["hookAdditionalContexts", "toolCallId", "startedAtMs", "completedAtMs"]);

/**
 * Cursor wraps each call as tool_call.<name>ToolCall { args, result? }, for
 * example shellToolCall, readToolCall, editToolCall, grepToolCall. Completed
 * records carry result.success or an error/rejection object instead.
 */
function classifyToolCall(record: Record<string, unknown>): CursorInbound {
  const call = asRecord(record.tool_call);
  const denied = record.subtype === "completed" && containsDenial(call);
  const callId = textValue(record.call_id) ?? textValue(call?.toolCallId);
  const entry = call ? toolEntry(call) : undefined;
  if (!callId || !entry) return { kind: "tool", denied };
  const status = record.subtype === "completed" ? completedStatus(entry.result, denied) : "running";
  const output = record.subtype === "completed" ? resultOutput(entry.result) : undefined;
  return {
    kind: "tool",
    denied,
    tool: {
      callId,
      name: entry.name,
      ...(entry.input ? { input: entry.input } : {}),
      status,
      ...(output ? { output } : {}),
    },
  };
}

function toolEntry(
  call: Record<string, unknown>,
): { name: string; input?: Record<string, unknown>; result?: Record<string, unknown> } | undefined {
  for (const [key, raw] of Object.entries(call)) {
    if (TOOL_CALL_METADATA.has(key)) continue;
    const value = asRecord(raw);
    if (!value) continue;
    const result = asRecord(value.result);
    if (key === "function") {
      const name = textValue(value.name);
      if (!name) continue;
      const input = parseArguments(value.arguments);
      return { name, ...(input ? { input } : {}), ...(result ? { result } : {}) };
    }
    const args = asRecord(value.args);
    const base = key.replace(/ToolCall$/u, "");
    // MCP calls name the real tool inside args.
    const name = base === "mcp" ? (textValue(args?.toolName) ?? textValue(args?.name) ?? base) : base;
    const input = base === "mcp" ? (asRecord(args?.args) ?? args) : args;
    return { name, ...(input ? { input } : {}), ...(result ? { result } : {}) };
  }
  return undefined;
}

function completedStatus(result: Record<string, unknown> | undefined, denied: boolean): "completed" | "failed" {
  if (denied) return "failed";
  if (!result) return "completed";
  const success = asRecord(result.success);
  if (!success) return "failed";
  const exitCode = success.exitCode;
  return typeof exitCode === "number" && exitCode !== 0 ? "failed" : "completed";
}

function resultOutput(result: Record<string, unknown> | undefined): string | undefined {
  if (!result) return undefined;
  const success = asRecord(result.success);
  if (success) {
    const shell = textValue(success.interleavedOutput) ?? joinOutput(success.stdout, success.stderr);
    if (shell) return shell;
    const matches = grepMatches(success);
    if (matches) return matches;
    return textValue(success.output) ?? textValue(success.message);
  }
  for (const key of ["error", "failure", "rejected", "permissionDenied"]) {
    const value = result[key];
    if (typeof value === "string" && value.trim()) return value;
    const nested = asRecord(value);
    const text =
      textValue(nested?.message) ?? textValue(nested?.reason) ?? textValue(nested?.error) ?? textValue(nested?.stderr);
    if (text) return text;
  }
  return undefined;
}

function joinOutput(stdout: unknown, stderr: unknown): string | undefined {
  const parts = [stdout, stderr].filter((part): part is string => typeof part === "string" && part.length > 0);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/** Flattens grep results into "file:line: text" rows. */
function grepMatches(value: unknown, depth = 0, rows: string[] = []): string | undefined {
  if (depth > 6 || rows.length >= 200 || !value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) grepMatches(item, depth + 1, rows);
    return depth === 0 && rows.length > 0 ? rows.join("\n") : undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.file === "string" && Array.isArray(record.matches)) {
    for (const match of record.matches) {
      const line = asRecord(match);
      if (line && typeof line.content === "string") {
        rows.push(`${record.file}:${typeof line.lineNumber === "number" ? line.lineNumber : "?"}: ${line.content}`);
      }
    }
  } else {
    for (const child of Object.values(record)) grepMatches(child, depth + 1, rows);
  }
  return depth === 0 && rows.length > 0 ? rows.join("\n") : undefined;
}

function parseArguments(value: unknown): Record<string, unknown> | undefined {
  if (asRecord(value)) return asRecord(value);
  if (typeof value !== "string") return undefined;
  try {
    return asRecord(JSON.parse(value) as unknown);
  } catch {
    return undefined;
  }
}

function classifyAssistant(record: Record<string, unknown>): CursorInbound {
  const text = assistantText(record.message);
  if (!text) return { kind: "ignore" };
  const hasTimestamp = record.timestamp_ms !== undefined && record.timestamp_ms !== null;
  const hasModelCall = record.model_call_id !== undefined && record.model_call_id !== null;
  // Buffered flush before a tool call. The streaming delta already carried this text.
  if (hasModelCall) return { kind: "ignore" };
  return { kind: "text", text, partial: hasTimestamp };
}

function classifyResult(record: Record<string, unknown>): CursorInbound {
  const subtype = textValue(record.subtype);
  const text = typeof record.result === "string" ? record.result : undefined;
  return {
    kind: "result",
    isError: record.is_error === true || (subtype?.startsWith("error") ?? false),
    ...(text === undefined ? {} : { text }),
    ...(subtype === undefined ? {} : { subtype }),
  };
}

function assistantText(message: unknown): string | undefined {
  const content = asRecord(message)?.content;
  if (typeof content === "string" && content.length > 0) return content;
  if (!Array.isArray(content)) return undefined;
  let text = "";
  for (const block of content) {
    const record = asRecord(block);
    if (record?.type === "text" && typeof record.text === "string") text += record.text;
  }
  return text.length > 0 ? text : undefined;
}

function containsDenial(value: unknown, depth = 0): boolean {
  if (depth > 8 || !value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => containsDenial(item, depth + 1));
  for (const [key, child] of Object.entries(value)) {
    if (isDenialKey(key, child)) return true;
    if (containsDenial(child, depth + 1)) return true;
  }
  return false;
}

function isDenialKey(key: string, value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  return key === "rejected" || key === "denied" || key === "permissionDenied" || key === "permission_denied";
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
