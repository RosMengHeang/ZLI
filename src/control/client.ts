import {
  CONTROL_PROTOCOL_VERSION,
  decodeControlResponse,
  type ControlMethod,
  type ControlRequest,
} from "./protocol.ts";

type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;

export interface RequestOptions {
  id?: string;
  timeoutMs?: number;
}

export interface ControlClient {
  request<T>(method: ControlMethod, params?: unknown, options?: RequestOptions): Promise<T>;
}

export function createControlClient(invoke: Invoke): ControlClient {
  return {
    async request<T>(method: ControlMethod, params: unknown = {}, options: RequestOptions = {}): Promise<T> {
      const request: ControlRequest = {
        id: options.id ?? globalThis.crypto.randomUUID(),
        protocolVersion: CONTROL_PROTOCOL_VERSION,
        method,
        params,
        timeoutMs: options.timeoutMs ?? 30_000,
      };
      const raw = await invoke("control_request", { request });
      return decodeControlResponse<T>(raw).result;
    },
  };
}

export const controlClient = createControlClient(async (command, args) => {
  const { invokeCmd } = await import("../tauri/invoke.ts");
  return invokeCmd<unknown>(command, args);
});
