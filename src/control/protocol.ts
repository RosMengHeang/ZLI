export const CONTROL_PROTOCOL_VERSION = 1 as const;

export type ControlMethod =
  | "workspace.list" | "workspace.open"
  | "agent.list" | "agent.queue_status" | "agent.spawn" | "agent.send" | "agent.read" | "agent.focus" | "agent.pause" | "agent.stop"
  | "worktree.audit"
  | "attention.list" | "attention.ack"
  | "session.list" | "session.reconcile" | "session.resume"
  | "runtime.health"
  | "browser.list" | "browser.open" | "browser.navigate" | "browser.wait" | "browser.snapshot"
  | "browser.click" | "browser.fill" | "browser.press" | "browser.eval" | "browser.console"
  | "browser.errors" | "browser.screenshot"
  | "taxchat.send";

export interface ControlRequest<T = unknown> {
  id: string;
  protocolVersion: typeof CONTROL_PROTOCOL_VERSION;
  method: ControlMethod;
  params: T;
  timeoutMs: number;
}

export interface ControlResponse<T = unknown> {
  id: string;
  protocolVersion: typeof CONTROL_PROTOCOL_VERSION;
  ok: true;
  result: T;
}

export class ControlClientError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ControlClientError";
    this.code = code;
    this.details = details;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function decodeControlResponse<T = unknown>(value: unknown): ControlResponse<T> {
  const envelope = record(value);
  if (!envelope || typeof envelope.id !== "string" || !envelope.id.trim() || typeof envelope.ok !== "boolean") {
    throw new ControlClientError("INVALID_CONTROL_RESPONSE", "Invalid control response");
  }
  if (!("protocolVersion" in envelope) || typeof envelope.protocolVersion !== "number") {
    throw new ControlClientError("INVALID_CONTROL_RESPONSE", "Invalid control response");
  }
  if (envelope.protocolVersion !== CONTROL_PROTOCOL_VERSION) {
    throw new ControlClientError("CONTROL_PROTOCOL_MISMATCH", "Unsupported control protocol version");
  }
  if (!envelope.ok) {
    if ("result" in envelope) throw new ControlClientError("INVALID_CONTROL_RESPONSE", "Invalid control response");
    const error = record(envelope.error);
    if (!error || typeof error.code !== "string" || !error.code || typeof error.message !== "string" || !error.message) {
      throw new ControlClientError("INVALID_CONTROL_RESPONSE", "Invalid control response");
    }
    throw new ControlClientError(error.code, error.message, error.details);
  }
  if ("error" in envelope) throw new ControlClientError("INVALID_CONTROL_RESPONSE", "Invalid control response");
  if (!("result" in envelope)) {
    throw new ControlClientError("INVALID_CONTROL_RESPONSE", "Invalid control response");
  }
  return {
    id: envelope.id,
    protocolVersion: CONTROL_PROTOCOL_VERSION,
    ok: true,
    result: envelope.result as T,
  };
}
