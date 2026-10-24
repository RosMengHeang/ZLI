import {
  type AgentToolAccess,
  isHttpServer,
  MCP_HEADER_NAME_PATTERN,
  McpListResult,
  type McpServerConfig,
  McpServerList,
  type McpSettingsOutcome,
  type RpcResponse,
} from "@zli-v2/contracts";
import { useCallback, useEffect, useState } from "react";

import { makeCommandId } from "../runtime/commandId.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";

type Dispatch = (request: unknown) => Promise<RpcResponse | undefined>;

export type McpTransport = "stdio" | "http";

export type McpDraft = {
  name: string;
  transport: McpTransport;
  command: string;
  args: string;
  env: string;
  url: string;
  headers: string;
  oauth: boolean;
  enabled: boolean;
};

export const EMPTY_DRAFT: McpDraft = {
  name: "",
  transport: "stdio",
  command: "",
  args: "",
  env: "",
  url: "",
  headers: "",
  oauth: false,
  enabled: true,
};

export const TRANSPORT_LABELS: Record<McpTransport, string> = {
  stdio: "Local process",
  http: "Remote server",
};

async function request(dispatch: Dispatch, command: Record<string, unknown>): Promise<McpListResult> {
  const response = await dispatch({ protocolVersion: 1, commandId: makeCommandId(), command });
  if (!response) throw new Error("ZLI is not connected to its runtime.");
  if (!response.accepted) throw new Error(response.error.message);
  const parsed = McpListResult.safeParse(response.result);
  if (!parsed.success) throw new Error("The runtime sent an unexpected reply. Restart ZLI and try again.");
  return parsed.data;
}

export function listMcpServers(dispatch: Dispatch): Promise<McpListResult> {
  return request(dispatch, { type: "mcp.list" });
}

export function saveMcpServers(dispatch: Dispatch, servers: readonly McpServerConfig[]): Promise<McpListResult> {
  return request(dispatch, { type: "mcp.save", servers });
}

export function setAgentToolAccess(dispatch: Dispatch, access: AgentToolAccess): Promise<McpListResult> {
  return request(dispatch, { type: "mcp.agentAccess", access });
}

export const AGENT_ACCESS_LABELS: Record<AgentToolAccess, string> = {
  full: "Start and message agents",
  read: "List and read agents",
  off: "Off",
};

export function draftFromServer(server: McpServerConfig): McpDraft {
  if (isHttpServer(server)) {
    return {
      ...EMPTY_DRAFT,
      name: server.name,
      transport: "http",
      url: server.url,
      headers: Object.entries(server.headers)
        .map(([key, value]) => `${key}: ${value}`)
        .join("\n"),
      oauth: server.oauth,
      enabled: server.enabled,
    };
  }
  return {
    ...EMPTY_DRAFT,
    name: server.name,
    command: server.command,
    args: server.args.join("\n"),
    env: Object.entries(server.env)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n"),
    enabled: server.enabled,
  };
}

/** One argument per line, so arguments with spaces need no quoting. Blank lines are dropped. */
export function argsFromText(text: string): string[] {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function envFromText(text: string): { env: Record<string, string> } | { problem: string } {
  const env: Record<string, string> = {};
  const lines = text.split(/\r?\n/u);
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line) continue;
    const equals = line.indexOf("=");
    if (equals <= 0) return { problem: `Environment line ${index + 1} needs the form NAME=value.` };
    const name = line.slice(0, equals).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      return {
        problem: `Environment line ${index + 1}: names use letters, digits, and _, and do not start with a digit.`,
      };
    }
    env[name] = line.slice(equals + 1);
  }
  return { env };
}

/** One `Name: value` header per line, as browsers' developer tools show them. Blank lines are dropped. */
export function headersFromText(text: string): { headers: Record<string, string> } | { problem: string } {
  const headers: Record<string, string> = {};
  const lines = text.split(/\r?\n/u);
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) return { problem: `Header line ${index + 1} needs the form Name: value.` };
    const name = line.slice(0, colon).trim();
    if (!MCP_HEADER_NAME_PATTERN.test(name)) {
      return { problem: `Header line ${index + 1}: names use letters, digits, and - only.` };
    }
    headers[name] = line.slice(colon + 1).trim();
  }
  return { headers };
}

function serverFromDraft(draft: McpDraft): McpServerConfig | { problem: string } {
  const name = draft.name.trim();
  if (draft.transport === "http") {
    const headers = headersFromText(draft.headers);
    if ("problem" in headers) return headers;
    return {
      name,
      enabled: draft.enabled,
      transport: "http",
      url: draft.url.trim(),
      headers: headers.headers,
      oauth: draft.oauth,
    };
  }
  const env = envFromText(draft.env);
  if ("problem" in env) return env;
  return { name, enabled: draft.enabled, command: draft.command.trim(), args: argsFromText(draft.args), env: env.env };
}

const FIELD_PREFIXES: Record<string, string> = { env: "Environment: ", args: "Arguments: ", headers: "Headers: " };

/** The list with `server` added, or replacing the one at `index`, or the first problem in plain words. */
export function applyServer(
  servers: readonly McpServerConfig[],
  server: McpServerConfig,
  index: number | undefined,
): { servers: McpServerConfig[] } | { problem: string } {
  const next = index === undefined ? [...servers, server] : servers.map((entry, at) => (at === index ? server : entry));
  const parsed = McpServerList.safeParse(next);
  if (parsed.success) return { servers: parsed.data };
  const issue = parsed.error.issues[0];
  const field = issue?.path[1];
  const prefix = typeof field === "string" ? (FIELD_PREFIXES[field] ?? "") : "";
  return { problem: `${prefix}${issue?.message ?? "This server cannot be saved."}` };
}

/**
 * The list after the draft replaces the server at `index`, or is added when `index` is undefined,
 * or the first problem with it in words a person can act on.
 */
export function applyDraft(
  servers: readonly McpServerConfig[],
  draft: McpDraft,
  index: number | undefined,
): { servers: McpServerConfig[] } | { problem: string } {
  const server = serverFromDraft(draft);
  if ("problem" in server) return server;
  if (!server.name) return { problem: "Add a name." };
  return applyServer(servers, server, index);
}

/** The command line as a shell would show it, for the row summary. */
export function commandLine(server: { command: string; args: readonly string[] }): string {
  return [server.command, ...server.args].map((part) => (/\s/u.test(part) ? `"${part}"` : part)).join(" ");
}

/** The row summary. Header values are often tokens, so only their names are shown. */
export function serverSummary(server: McpServerConfig): string {
  if (!isHttpServer(server)) return commandLine(server);
  const headers = Object.keys(server.headers).map((name) => `${name}: ••••`);
  return [server.url, ...headers, ...(server.oauth ? ["sign in with browser"] : [])].join(" · ");
}

/** Agents start npx without a shell, which on Windows needs cmd in front of it. */
export function isWindows(): boolean {
  if (typeof navigator === "undefined") return false;
  return /^win/iu.test(navigator.platform || "") || /windows/iu.test(navigator.userAgent || "");
}

const SETTINGS_NAMES: Record<string, string> = {
  "cursor-agent": "Cursor",
  droid: "Droid",
  kimi: "Kimi Code",
  gemini: "Gemini",
  qwen: "Qwen Code",
};

/** Settings files ZLI could not update, phrased for the person who owns them. */
export function settingsProblems(outcomes: readonly McpSettingsOutcome[]): string[] {
  return outcomes
    .filter((outcome) => outcome.status === "skipped-invalid" || outcome.status === "failed")
    .map((outcome) => {
      const name = SETTINGS_NAMES[outcome.provider] ?? outcome.provider;
      const reason =
        outcome.status === "skipped-invalid"
          ? `${outcome.message ?? "It could not be read."} ZLI left it unchanged.`
          : `It could not be written${outcome.message ? ` (${outcome.message})` : ""}.`;
      return `${name}: ${outcome.path}. ${reason}`;
    });
}

export type McpServersState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; result: McpListResult };

export function useMcpServers(): {
  state: McpServersState;
  reload(): void;
  save(servers: readonly McpServerConfig[]): Promise<McpListResult>;
  setAgentAccess(access: AgentToolAccess): Promise<McpListResult>;
} {
  const { dispatch } = useRuntime();
  const [state, setState] = useState<McpServersState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is the retry trigger.
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    listMcpServers(dispatch)
      .then((result) => {
        if (!cancelled) setState({ status: "ready", result });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [dispatch, attempt]);

  const save = useCallback(
    async (servers: readonly McpServerConfig[]) => {
      const result = await saveMcpServers(dispatch, servers);
      setState({ status: "ready", result });
      return result;
    },
    [dispatch],
  );

  const setAgentAccess = useCallback(
    async (access: AgentToolAccess) => {
      const result = await setAgentToolAccess(dispatch, access);
      setState({ status: "ready", result });
      return result;
    },
    [dispatch],
  );

  return { state, reload: () => setAttempt((value) => value + 1), save, setAgentAccess };
}
