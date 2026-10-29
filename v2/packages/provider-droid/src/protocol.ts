export type DroidPermissionMode = "read-only" | "supervised" | "full-access";

/**
 * One `droid exec` process per chat, driven by JSON-RPC on stdin and stdout. Model, autonomy, and
 * reasoning flags have no effect in this mode, so every setting goes through the session requests.
 */
export function droidArgs(cwd: string): string[] {
  return ["exec", "--input-format", "stream-jsonrpc", "--output-format", "stream-jsonrpc", "--cwd", cwd];
}

// factoryProtocolVersion is optional and is left out, so a newer CLI does not log a version mismatch.
const DROID_API_VERSION = "1.0.0";

export type DroidSessionSettings = {
  interactionMode: "auto" | "spec";
  autonomyLevel: "off" | "low" | "medium" | "high";
};

// Read only is Droid's spec mode: it researches and proposes, and asks before it leaves spec mode
// to implement. Supervised is autonomy low, which edits files and runs read-only commands, and
// asks before anything riskier. Full access is autonomy high, and the client also approves any
// request Droid still sends, which is what --skip-permissions-unsafe does in plain exec mode.
export function droidSessionSettings(mode: DroidPermissionMode): DroidSessionSettings {
  if (mode === "read-only") return { interactionMode: "spec", autonomyLevel: "off" };
  if (mode === "supervised") return { interactionMode: "auto", autonomyLevel: "low" };
  return { interactionMode: "auto", autonomyLevel: "high" };
}

export function droidRequest(id: string, method: string, params: Record<string, unknown>): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    type: "request",
    factoryApiVersion: DROID_API_VERSION,
    id,
    method,
    params,
  };
}

export function droidResponse(id: string, result: Record<string, unknown>): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    type: "response",
    factoryApiVersion: DROID_API_VERSION,
    id,
    result,
  };
}

export function droidErrorResponse(id: string, code: number, message: string): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    type: "response",
    factoryApiVersion: DROID_API_VERSION,
    id,
    error: { code, message },
  };
}

export const MAX_DROID_LINE_CHARS = 1_000_000;

export type DroidLine = { type: "skip" } | { type: "invalid" } | { type: "message"; value: unknown };

export function decodeDroidLine(line: string): DroidLine {
  const trimmed = line.replace(/\r$/u, "").trim();
  if (!trimmed?.startsWith("{")) return { type: "skip" };
  try {
    return { type: "message", value: JSON.parse(trimmed) as unknown };
  } catch {
    return { type: "invalid" };
  }
}
