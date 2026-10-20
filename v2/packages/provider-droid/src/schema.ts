export type DroidInbound =
  | { kind: "init"; sessionId: string }
  | { kind: "text"; text: string }
  | { kind: "completion"; isError: boolean; text?: string }
  | { kind: "error"; message: string }
  | { kind: "ignore" }
  | { kind: "invalid"; reason: "init" | "message" };

/**
 * stream-json lines seen from `droid exec`: system/init, message (user echo and
 * assistant text), reasoning, tool_call, tool_result, and completion. Only init,
 * assistant text, completion, and error records change turn state.
 */
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
      return { kind: "completion", isError, ...(text === undefined ? {} : { text }) };
    }
    case "error":
      return { kind: "error", message: errorText(record) ?? "Droid CLI reported an error." };
    default:
      return { kind: "ignore" };
  }
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
