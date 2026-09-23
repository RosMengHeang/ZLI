export const CURSOR_TOOL_DENY_MESSAGE = "Cursor CLI denied a tool call, which this adapter does not approve.";

export type CursorInbound =
  | { kind: "init"; sessionId: string }
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
  if (record.type === "tool_call" && record.subtype === "completed" && containsDenial(record.tool_call)) {
    return CURSOR_TOOL_DENY_MESSAGE;
  }
  return undefined;
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
