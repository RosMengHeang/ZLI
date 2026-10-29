import { compactUsage, type ProviderUsage, sumCounts, tokenCount } from "@zli-v2/shared";

export type DroidToolUse = { id: string; name: string; input?: Record<string, unknown> };

export type DroidReportedSettings = {
  modelId?: string;
  reasoningEffort?: string;
  interactionMode?: string;
  autonomyLevel?: string;
};

export type DroidNotification =
  | { type: "text_delta"; messageId: string; blockIndex: number; text: string }
  | { type: "assistant_message"; messageId: string; texts: string[]; toolUses: DroidToolUse[] }
  | { type: "tool_call"; tool: DroidToolUse }
  | { type: "tool_result"; callId: string; isError: boolean; output?: string }
  | { type: "turn_completed"; turnId?: string; reason: string; usage?: ProviderUsage }
  | { type: "error"; message: string }
  | { type: "settings"; settings: DroidReportedSettings }
  | { type: "working_state"; state: string }
  | { type: "permission_resolved"; requestId: string }
  | { type: "ignore" };

export type DroidInbound =
  | { kind: "response"; id: string; result: Record<string, unknown> }
  | { kind: "error_response"; id: string; message: string }
  | { kind: "request"; id: string; method: string; params: Record<string, unknown> }
  | { kind: "notification"; sessionId?: string; notification: DroidNotification }
  | { kind: "ignore" }
  | { kind: "invalid" };

/**
 * Lines from `droid exec --output-format stream-jsonrpc`: responses to the client's requests,
 * requests Droid needs answered (droid.request_permission, droid.ask_user, droid.pick_options), and
 * droid.session_notification records that stream the turn.
 */
export function classifyDroidMessage(value: unknown): DroidInbound {
  const record = asRecord(value);
  if (!record || typeof record.type !== "string") return { kind: "invalid" };
  const id = textValue(record.id);
  switch (record.type) {
    case "response": {
      if (!id) return { kind: "invalid" };
      const error = asRecord(record.error);
      if (error)
        return { kind: "error_response", id, message: textValue(error.message) ?? "Droid CLI request failed." };
      return { kind: "response", id, result: asRecord(record.result) ?? {} };
    }
    case "request": {
      const method = textValue(record.method);
      if (!id || !method) return { kind: "invalid" };
      return { kind: "request", id, method, params: asRecord(record.params) ?? {} };
    }
    case "notification": {
      if (record.method !== "droid.session_notification") return { kind: "ignore" };
      const params = asRecord(record.params);
      const notification = asRecord(params?.notification);
      if (!notification) return { kind: "invalid" };
      const sessionId = textValue(params?.sessionId);
      return {
        kind: "notification",
        ...(sessionId ? { sessionId } : {}),
        notification: classifyNotification(notification),
      };
    }
    default:
      return { kind: "ignore" };
  }
}

function classifyNotification(record: Record<string, unknown>): DroidNotification {
  switch (record.type) {
    case "assistant_text_delta": {
      const messageId = textValue(record.messageId);
      const text = typeof record.textDelta === "string" ? record.textDelta : "";
      if (!messageId || !text) return { type: "ignore" };
      const blockIndex = typeof record.blockIndex === "number" ? record.blockIndex : 0;
      return { type: "text_delta", messageId, blockIndex, text };
    }
    case "create_message": {
      const message = asRecord(record.message);
      const messageId = textValue(message?.id);
      if (!message || !messageId || message.role !== "assistant") return { type: "ignore" };
      const blocks = Array.isArray(message.content) ? message.content.map(asRecord) : [];
      const texts: string[] = [];
      const toolUses: DroidToolUse[] = [];
      for (const block of blocks) {
        if (block?.type === "text") {
          const text = textValue(block.text);
          if (text) texts.push(text);
        } else if (block?.type === "tool_use") {
          const tool = toolUse(block);
          if (tool) toolUses.push(tool);
        }
      }
      return { type: "assistant_message", messageId, texts, toolUses };
    }
    case "tool_call": {
      const tool = toolUse(asRecord(record.toolUse));
      return tool ? { type: "tool_call", tool } : { type: "ignore" };
    }
    case "tool_result": {
      const callId = textValue(record.toolUseId);
      if (!callId) return { type: "ignore" };
      const output = resultText(record.content);
      return {
        type: "tool_result",
        callId,
        isError: record.isError === true || exitedWithFailure(output),
        ...(output ? { output } : {}),
      };
    }
    case "agent_turn_completed": {
      const turnId = textValue(record.turnId);
      const usage = turnUsage(record.tokenUsage);
      return {
        type: "turn_completed",
        reason: textValue(record.reason) ?? "completed",
        ...(turnId ? { turnId } : {}),
        ...(usage ? { usage } : {}),
      };
    }
    case "error":
      return { type: "error", message: errorText(record) ?? "Droid CLI reported an error." };
    case "settings_updated": {
      const settings = asRecord(record.settings);
      return settings ? { type: "settings", settings: reportedSettings(settings) } : { type: "ignore" };
    }
    case "droid_working_state_changed": {
      const state = textValue(record.newState);
      return state ? { type: "working_state", state } : { type: "ignore" };
    }
    case "permission_resolved": {
      const requestId = textValue(record.requestId);
      return requestId ? { type: "permission_resolved", requestId } : { type: "ignore" };
    }
    default:
      return { type: "ignore" };
  }
}

export function reportedSettings(value: unknown): DroidReportedSettings {
  const record = asRecord(value) ?? {};
  const settings: DroidReportedSettings = {};
  for (const key of ["modelId", "reasoningEffort", "interactionMode", "autonomyLevel"] as const) {
    const entry = textValue(record[key]);
    if (entry) settings[key] = entry;
  }
  return settings;
}

/** Model id to its default reasoning level, from the availableModels list a session reports. */
export function modelDefaults(value: unknown): Map<string, string> {
  const defaults = new Map<string, string>();
  for (const entry of Array.isArray(value) ? value : []) {
    const model = asRecord(entry);
    const id = textValue(model?.id);
    const effort = textValue(model?.defaultReasoningEffort);
    if (id && effort) defaults.set(id, effort);
  }
  return defaults;
}

export type DroidPermissionRequest = {
  toolUses: Array<DroidToolUse & { displayName: string }>;
  options: string[];
};

export function parsePermissionRequest(params: Record<string, unknown>): DroidPermissionRequest {
  const toolUses: DroidPermissionRequest["toolUses"] = [];
  for (const entry of Array.isArray(params.toolUses) ? params.toolUses : []) {
    const record = asRecord(entry);
    const tool = toolUse(asRecord(record?.toolUse));
    if (!tool) continue;
    // MCP tools carry a server-qualified name; details name the tool the way its server does.
    const details = asRecord(record?.details);
    const displayName = (details?.type === "mcp_tool" ? textValue(details.actualToolName) : undefined) ?? tool.name;
    toolUses.push({ ...tool, displayName });
  }
  const options = (Array.isArray(params.options) ? params.options : [])
    .map((option) => textValue(asRecord(option)?.value))
    .filter((value): value is string => value !== undefined);
  return { toolUses, options };
}

export type DroidQuestion = { index: number; topic?: string; question: string; options: string[] };

export function parseQuestions(params: Record<string, unknown>): DroidQuestion[] {
  const questions: DroidQuestion[] = [];
  for (const entry of Array.isArray(params.questions) ? params.questions : []) {
    const record = asRecord(entry);
    const question = textValue(record?.question);
    if (!record || !question || typeof record.index !== "number") continue;
    const topic = textValue(record.topic);
    const options = (Array.isArray(record.options) ? record.options : []).filter(
      (option): option is string => typeof option === "string" && option.trim().length > 0,
    );
    questions.push({ index: record.index, question, options, ...(topic ? { topic } : {}) });
  }
  return questions;
}

/**
 * The token usage that agent_turn_completed reports is that turn's own. Like Anthropic's API,
 * inputTokens leaves out cache reads and writes, so they are added back. Factory credits are not
 * dollars and are left out.
 */
function turnUsage(value: unknown): ProviderUsage | undefined {
  const usage = asRecord(value);
  if (!usage) return undefined;
  const cacheRead = tokenCount(usage.cacheReadTokens);
  return compactUsage({
    inputTokens: sumCounts(tokenCount(usage.inputTokens), tokenCount(usage.cacheCreationTokens), cacheRead),
    cachedInputTokens: cacheRead,
    outputTokens: tokenCount(usage.outputTokens),
  });
}

function toolUse(record: Record<string, unknown> | undefined): DroidToolUse | undefined {
  const id = textValue(record?.id);
  const name = textValue(record?.name);
  if (!id || !name) return undefined;
  const input = asRecord(record?.input);
  return { id, name, ...(input ? { input } : {}) };
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
  const direct = textValue(record.message) ?? textValue(record.error);
  if (direct) return direct;
  return textValue(asRecord(record.error)?.message);
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
