export type ClaudeInbound =
  | { kind: "init"; sessionId: string }
  | { kind: "text"; text: string; partial: boolean; subagent: boolean }
  | { kind: "result"; isError: boolean; text?: string; subtype?: string }
  | { kind: "control_request"; requestId: string; subtype: string }
  | { kind: "control_response"; requestId: string; ok: boolean; error?: string }
  | { kind: "ignore" }
  | { kind: "invalid"; reason: "init" | "message" };

export function userTurnMessage(text: string): {
  type: "user";
  session_id: "";
  parent_tool_use_id: null;
  message: { role: "user"; content: string };
} {
  return {
    type: "user",
    session_id: "",
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

export function denyToolRequest(requestId: string): {
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
      response: {
        behavior: "deny",
        message: "Claude Code adapter does not support tool approvals.",
      },
    },
  };
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
    return {
      kind: "result",
      isError: record.is_error === true || (subtype?.startsWith("error") ?? false),
      ...(text === undefined ? {} : { text }),
      ...(subtype === undefined ? {} : { subtype }),
    };
  }
  if (record.type === "control_request") return classifyControlRequest(record);
  if (record.type === "control_response") return classifyControlResponse(record);
  return { kind: "ignore" };
}

function classifyControlRequest(record: Record<string, unknown>): ClaudeInbound {
  const request = asRecord(record.request);
  const requestId = typeof record.request_id === "string" ? record.request_id : "";
  const subtype = typeof request?.subtype === "string" ? request.subtype : "";
  if (!requestId || !subtype) return { kind: "invalid", reason: "message" };
  return { kind: "control_request", requestId, subtype };
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
