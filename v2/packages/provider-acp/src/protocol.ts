import { z } from "zod";

export const ACP_PROTOCOL_VERSION = 1;
export const MAX_ACP_LINE_CHARS = 8_000_000;

/** JSON-RPC codes the agent and client exchange. -32000 is ACP's "authentication required". */
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INTERNAL_ERROR = -32603;
export const ACP_AUTH_REQUIRED = -32000;

const JsonRpcId = z.union([z.string().min(1), z.number().int()]);
export type JsonRpcId = z.infer<typeof JsonRpcId>;

export const JsonRpcError = z
  .object({ code: z.number(), message: z.string(), data: z.unknown().optional() })
  .passthrough();
export type JsonRpcError = z.infer<typeof JsonRpcError>;

const JsonRpcRequest = z
  .object({ id: JsonRpcId, method: z.string().min(1), params: z.unknown().optional() })
  .passthrough();
const JsonRpcNotification = z.object({ method: z.string().min(1), params: z.unknown().optional() }).passthrough();
const JsonRpcResponse = z
  .object({ id: JsonRpcId, result: z.unknown().optional(), error: JsonRpcError.optional() })
  .passthrough();

export type AcpInbound =
  | { type: "request"; id: JsonRpcId; method: string; params: unknown }
  | { type: "notification"; method: string; params: unknown }
  | { type: "response"; id: JsonRpcId; result: unknown; error?: JsonRpcError };

export type AcpLine = { type: "skip" } | { type: "invalid" } | { type: "message"; message: AcpInbound };

/** Agents print banners and logs on stdout too; only lines that look like JSON objects are protocol traffic. */
export function decodeAcpLine(line: string): AcpLine {
  const trimmed = line.replace(/\r$/u, "").trim();
  if (!trimmed.startsWith("{")) return { type: "skip" };
  let value: unknown;
  try {
    value = JSON.parse(trimmed) as unknown;
  } catch {
    return { type: "invalid" };
  }
  const request = JsonRpcRequest.safeParse(value);
  if (request.success) {
    return {
      type: "message",
      message: { type: "request", id: request.data.id, method: request.data.method, params: request.data.params },
    };
  }
  const notification = JsonRpcNotification.safeParse(value);
  if (notification.success) {
    return {
      type: "message",
      message: { type: "notification", method: notification.data.method, params: notification.data.params },
    };
  }
  const response = JsonRpcResponse.safeParse(value);
  if (response.success) {
    return {
      type: "message",
      message: {
        type: "response",
        id: response.data.id,
        result: response.data.result,
        ...(response.data.error ? { error: response.data.error } : {}),
      },
    };
  }
  return { type: "invalid" };
}

export function encodeRequest(id: number, method: string, params: unknown): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
}

export function encodeNotification(method: string, params: unknown): string {
  return `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`;
}

export function encodeResult(id: JsonRpcId, result: unknown): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`;
}

export function encodeError(id: JsonRpcId, code: number, message: string): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`;
}

export function initializeParams(): Record<string, unknown> {
  return {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  };
}

export const InitializeResult = z
  .object({
    protocolVersion: z.number().int(),
    agentCapabilities: z
      .object({
        promptCapabilities: z.object({ image: z.boolean().optional() }).passthrough().optional(),
        mcpCapabilities: z.object({ http: z.boolean().optional() }).passthrough().optional(),
      })
      .passthrough()
      .optional(),
    authMethods: z
      .array(z.object({ id: z.string(), name: z.string().optional(), description: z.string().nullish() }).passthrough())
      .optional(),
  })
  .passthrough();
export type InitializeResult = z.infer<typeof InitializeResult>;

const SelectOption = z.object({ value: z.string(), name: z.string().optional() }).passthrough();

/** Session config options (current ACP). OpenCode and Kimi Code report model and mode this way. */
export const SessionConfigOption = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    category: z.string().nullish(),
    type: z.string().optional(),
    currentValue: z.unknown().optional(),
    options: z.array(z.unknown()).optional(),
  })
  .passthrough();
export type SessionConfigOption = z.infer<typeof SessionConfigOption>;

export const SessionModels = z
  .object({
    currentModelId: z.string().optional(),
    availableModels: z
      .array(z.object({ modelId: z.string().min(1), name: z.string().optional() }).passthrough())
      .optional(),
  })
  .passthrough();

export const SessionModes = z
  .object({
    currentModeId: z.string().optional(),
    availableModes: z.array(z.object({ id: z.string().min(1), name: z.string().optional() }).passthrough()).optional(),
  })
  .passthrough();

export const NewSessionResult = z
  .object({
    sessionId: z.string().min(1),
    modes: SessionModes.nullish(),
    models: SessionModels.nullish(),
    configOptions: z.array(z.unknown()).nullish(),
  })
  .passthrough();
export type NewSessionResult = z.infer<typeof NewSessionResult>;

export const PromptResult = z.object({ stopReason: z.string().min(1) }).passthrough();

export const PermissionOption = z
  .object({ optionId: z.string().min(1), name: z.string().optional(), kind: z.string().optional() })
  .passthrough();
export type PermissionOption = z.infer<typeof PermissionOption>;

export const RequestPermissionParams = z
  .object({
    sessionId: z.string().optional(),
    toolCall: z.record(z.string(), z.unknown()).optional(),
    options: z.array(PermissionOption),
  })
  .passthrough();
export type RequestPermissionParams = z.infer<typeof RequestPermissionParams>;

export function parseConfigOptions(value: unknown): SessionConfigOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = SessionConfigOption.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

export function selectOptionValues(option: SessionConfigOption): string[] {
  return (option.options ?? []).flatMap((item) => {
    const parsed = SelectOption.safeParse(item);
    return parsed.success ? [parsed.data.value] : [];
  });
}
