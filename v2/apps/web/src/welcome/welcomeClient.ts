import {
  type HistoryFolder,
  HistoryScanResult,
  type ProviderDiscovery,
  ProvidersDiscoverResult,
  type RpcResponse,
} from "@zli-v2/contracts";

import { makeCommandId } from "../runtime/commandId.js";

export type Dispatch = (request: unknown) => Promise<RpcResponse | undefined>;

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

async function request<T>(
  dispatch: Dispatch,
  command: Record<string, unknown>,
  parse: (value: unknown) => T | undefined,
  fallback: string,
): Promise<Result<T>> {
  try {
    const response = await dispatch({ protocolVersion: 1, commandId: makeCommandId(), command });
    if (!response) return { ok: false, error: fallback };
    if (!response.accepted) return { ok: false, error: response.error.message };
    const value = parse(response.result);
    return value === undefined ? { ok: false, error: fallback } : { ok: true, value };
  } catch {
    return { ok: false, error: fallback };
  }
}

export function scanHistory(dispatch: Dispatch): Promise<Result<HistoryFolder[]>> {
  return request(
    dispatch,
    { type: "history.scan" },
    (value) => HistoryScanResult.safeParse(value).data?.folders,
    "Past sessions could not be read. Try again.",
  );
}

export function discoverProviders(dispatch: Dispatch): Promise<Result<ProviderDiscovery[]>> {
  return request(
    dispatch,
    { type: "providers.discover" },
    (value) => ProvidersDiscoverResult.safeParse(value).data?.providers,
    "ZLI could not look for agents. Try again.",
  );
}
