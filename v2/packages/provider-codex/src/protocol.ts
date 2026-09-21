import { z } from "zod";

export const JsonRpcId = z.union([z.string().min(1), z.number().int().nonnegative()]);
export type JsonRpcId = z.infer<typeof JsonRpcId>;

export const JsonRpcRequest = z.object({
  jsonrpc: z.literal("2.0"),
  id: JsonRpcId,
  method: z.string().min(1),
  params: z.unknown().optional(),
});
export type JsonRpcRequest = z.infer<typeof JsonRpcRequest>;

export const JsonRpcNotification = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.string().min(1),
  params: z.unknown().optional(),
});
export type JsonRpcNotification = z.infer<typeof JsonRpcNotification>;

export const JsonRpcResponse = z.object({
  jsonrpc: z.literal("2.0"),
  id: JsonRpcId,
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string(), data: z.unknown().optional() }).optional(),
});
export type JsonRpcResponse = z.infer<typeof JsonRpcResponse>;

export const JsonRpcMessage = z.union([JsonRpcRequest, JsonRpcNotification, JsonRpcResponse]);
export type JsonRpcMessage = z.infer<typeof JsonRpcMessage>;

export function encodeJsonRpc(message: JsonRpcMessage): string {
  return `${JSON.stringify(message)}\n`;
}

export function decodeJsonRpc(line: string): JsonRpcMessage | undefined {
  try {
    const parsed = JsonRpcMessage.safeParse(JSON.parse(line) as unknown);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
