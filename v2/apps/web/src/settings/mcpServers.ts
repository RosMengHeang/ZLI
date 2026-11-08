import {
  type AgentToolAccess,
  type AgentToolScope,
  isHttpServer,
  MCP_CATALOG,
  MCP_HEADER_NAME_PATTERN,
  McpImportResult,
  McpListResult,
  type McpServerConfig,
  type McpServerHealth,
  McpServerList,
  McpSignInStart,
  type McpSignInState,
  McpTestResult,
  type RpcResponse,
} from "@zli-v2/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { openExternalLink } from "../review/links.js";
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
  /** Off means every project. */
  limitProjects: boolean;
  projects: string[];
  /** Kept as they are; the tools panel changes them. */
  disabledTools: string[];
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
  limitProjects: false,
  projects: [],
  disabledTools: [],
};

export const TRANSPORT_LABELS: Record<McpTransport, string> = {
  stdio: "Local process",
  http: "Remote server",
};

async function send(dispatch: Dispatch, command: Record<string, unknown>): Promise<unknown> {
  const response = await dispatch({ protocolVersion: 1, commandId: makeCommandId(), command });
  if (!response) throw new Error("ZLI is not connected to its runtime.");
  if (!response.accepted) throw new Error(response.error.message);
  return response.result;
}

const UNEXPECTED = "The runtime sent an unexpected reply. Restart ZLI and try again.";

async function request(dispatch: Dispatch, command: Record<string, unknown>): Promise<McpListResult> {
  const parsed = McpListResult.safeParse(await send(dispatch, command));
  if (!parsed.success) throw new Error(UNEXPECTED);
  return parsed.data;
}

export async function startMcpSignIn(dispatch: Dispatch, name: string): Promise<McpSignInStart> {
  const parsed = McpSignInStart.safeParse(await send(dispatch, { type: "mcp.signIn", name }));
  if (!parsed.success) throw new Error(UNEXPECTED);
  return parsed.data;
}

export function waitForMcpSignIn(dispatch: Dispatch, attemptId: string): Promise<McpListResult> {
  return request(dispatch, { type: "mcp.signIn.wait", attemptId });
}

export function cancelMcpSignIn(dispatch: Dispatch, attemptId: string): Promise<McpListResult> {
  return request(dispatch, { type: "mcp.signIn.cancel", attemptId });
}

export function signOutMcpServer(dispatch: Dispatch, name: string): Promise<McpListResult> {
  return request(dispatch, { type: "mcp.signOut", name });
}

export async function testMcpServer(dispatch: Dispatch, name: string): Promise<McpTestResult> {
  const parsed = McpTestResult.safeParse(await send(dispatch, { type: "mcp.test", name }));
  if (!parsed.success) throw new Error(UNEXPECTED);
  return parsed.data;
}

export async function scanMcpImports(dispatch: Dispatch): Promise<McpImportResult> {
  const parsed = McpImportResult.safeParse(await send(dispatch, { type: "mcp.import.scan" }));
  if (!parsed.success) throw new Error(UNEXPECTED);
  return parsed.data;
}

/** Sign-ins for servers that came from plugins rather than the person's own list. */
export function pluginSignIns(result: McpListResult): McpSignInState[] {
  return result.signIns.filter(
    (entry) => !result.servers.some((server) => server.name.toLowerCase() === entry.name.toLowerCase()),
  );
}

/** The last test of a server, matched by name. */
export function healthFor(result: McpListResult, name: string): McpServerHealth | undefined {
  const key = name.toLowerCase();
  return result.health.find((entry) => entry.name.toLowerCase() === key);
}

export function healthFromTest(test: McpTestResult): McpServerHealth {
  return {
    name: test.name,
    ok: test.ok,
    toolCount: test.tools.length,
    ...(test.problem ? { problem: test.problem } : {}),
    ...(test.needsSignIn ? { needsSignIn: true } : {}),
    testedAt: test.testedAt,
  };
}

/** The list with this server's last test replaced by `test`. */
export function mergeHealth(health: readonly McpServerHealth[], test: McpTestResult): McpServerHealth[] {
  const key = test.name.toLowerCase();
  return [...health.filter((entry) => entry.name.toLowerCase() !== key), healthFromTest(test)];
}

export type McpStatusTone = "ok" | "problem" | "warning" | "unknown";
export type McpStatus = { tone: McpStatusTone; label: string };

export function toolCountText(count: number): string {
  return count === 1 ? "1 tool" : `${count} tools`;
}

/** What the status dot says: sign-in first, then the last test. */
export function serverStatus(result: McpListResult, name: string): McpStatus {
  const signIn = signInFor(result, name);
  if (signIn && !signIn.signedIn) {
    return { tone: "warning", label: signIn.expired ? "Sign-in expired" : "Not signed in" };
  }
  const health = healthFor(result, name);
  if (!health) return { tone: "unknown", label: "Not tested" };
  if (health.ok) return { tone: "ok", label: `Working, ${toolCountText(health.toolCount)}` };
  if (health.needsSignIn) return { tone: "warning", label: health.problem ?? "Not signed in" };
  return { tone: "problem", label: health.problem ?? "Not working" };
}

/** The server with these tools turned off. An empty list is left out of the saved file. */
export function withDisabledTools<T extends McpServerConfig>(server: T, disabled: readonly string[]): T {
  const { disabledTools: _previous, ...rest } = server;
  return (disabled.length > 0 ? { ...rest, disabledTools: [...disabled] } : rest) as T;
}

/** The server limited to these project paths. An empty list means every project and is left out. */
export function withProjects<T extends McpServerConfig>(server: T, projects: readonly string[]): T {
  const { projects: _previous, ...rest } = server;
  return (projects.length > 0 ? { ...rest, projects: [...projects] } : rest) as T;
}

/** The last part of a path, for projects ZLI no longer lists. */
export function pathName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/u, "")
      .split(/[\\/]/u)
      .pop() || path
  );
}

export function sameProjectPath(left: string, right: string): boolean {
  const normal = (path: string) => path.replace(/\\/gu, "/").replace(/\/+$/u, "").toLowerCase();
  return normal(left) === normal(right);
}

/** Project names for the saved paths, using the name ZLI shows when it knows the project. */
export function projectNames(paths: readonly string[], projects: readonly { name: string; path: string }[]): string[] {
  return paths.map((path) => projects.find((project) => sameProjectPath(project.path, path))?.name ?? pathName(path));
}

export function projectCountText(count: number): string {
  return count === 1 ? "1 project" : `${count} projects`;
}

export const PROJECT_LIMIT_NOTE =
  "Cursor and Droid, and Gemini, Kimi Code, and Qwen Code in terminals, read servers from settings shared by every project, so they skip servers limited to some projects.";

export function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** The catalog entry whose address is on the same host, for logos and titles of plugin servers. */
export function catalogEntryForUrl(url: string) {
  const host = urlHost(url).toLowerCase();
  return MCP_CATALOG.find(
    (entry) => entry.template.transport === "http" && urlHost(entry.template.url).toLowerCase() === host,
  );
}

/** The sign-in state for one server, matched by name. */
export function signInFor(result: McpListResult, name: string): McpSignInState | undefined {
  const key = name.toLowerCase();
  return result.signIns.find((entry) => entry.name.toLowerCase() === key);
}

/** "Signed in as octocat" or "Signed in", for the row or card. */
export function signedInText(state: McpSignInState | undefined): string | undefined {
  if (!state?.signedIn) return undefined;
  return state.account ? `Signed in as ${state.account}` : "Signed in";
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

export function setAgentToolScope(dispatch: Dispatch, scope: AgentToolScope): Promise<McpListResult> {
  return request(dispatch, { type: "mcp.agentScope", scope });
}

export const AGENT_SCOPE_LABELS: Record<AgentToolScope, string> = {
  project: "In their own project",
  all: "In every project",
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
      ...shared(server),
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
    ...shared(server),
  };
}

function shared(server: McpServerConfig): Pick<McpDraft, "limitProjects" | "projects" | "disabledTools"> {
  const projects = server.projects ?? [];
  return {
    limitProjects: projects.length > 0,
    projects: [...projects],
    disabledTools: [...(server.disabledTools ?? [])],
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
  if (draft.limitProjects && draft.projects.length === 0) {
    return { problem: "Pick at least one project, or choose All projects." };
  }
  const finish = (server: McpServerConfig) =>
    withProjects(withDisabledTools(server, draft.disabledTools), draft.limitProjects ? draft.projects : []);
  const name = draft.name.trim();
  if (draft.transport === "http") {
    const headers = headersFromText(draft.headers);
    if ("problem" in headers) return headers;
    return finish({
      name,
      enabled: draft.enabled,
      transport: "http",
      url: draft.url.trim(),
      headers: headers.headers,
      oauth: draft.oauth,
    });
  }
  const env = envFromText(draft.env);
  if ("problem" in env) return env;
  return finish({
    name,
    enabled: draft.enabled,
    command: draft.command.trim(),
    args: argsFromText(draft.args),
    env: env.env,
  });
}

const FIELD_PREFIXES: Record<string, string> = {
  env: "Environment: ",
  args: "Arguments: ",
  headers: "Headers: ",
  projects: "Projects: ",
  disabledTools: "Tools: ",
};

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
  return [server.url, ...headers].join(" · ");
}

/** Agents start npx without a shell, which on Windows needs cmd in front of it. */
export function isWindows(): boolean {
  if (typeof navigator === "undefined") return false;
  return /^win/iu.test(navigator.platform || "") || /windows/iu.test(navigator.userAgent || "");
}

export type McpServersState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; result: McpListResult };

/** A sign-in waiting on the browser. `code` is the one to enter on the page, for GitHub. */
export type PendingSignIn = { name: string; attemptId: string; url: string; code?: string };

export const SIGN_IN_CANCELED = "Sign-in canceled.";

export function useMcpServers(): {
  state: McpServersState;
  reload(): void;
  save(servers: readonly McpServerConfig[]): Promise<McpListResult>;
  setAgentAccess(access: AgentToolAccess): Promise<McpListResult>;
  setAgentScope(scope: AgentToolScope): Promise<McpListResult>;
  /** Signs in and resolves once it is saved. Rejects with the problem, or SIGN_IN_CANCELED. */
  signIn(name: string): Promise<void>;
  cancelSignIn(name: string): void;
  /** Opens the sign-in page again, for when the browser tab was closed. */
  reopenSignIn(name: string): Promise<string | undefined>;
  signOut(name: string): Promise<McpListResult>;
  pending: Readonly<Record<string, PendingSignIn>>;
  /** Starts the server and lists its tools. Rejects only when the runtime could not run the test. */
  test(name: string): Promise<McpTestResult>;
  /** The last test result per server name, with the tools it listed. */
  tests: Readonly<Record<string, McpTestResult>>;
  testing: Readonly<Record<string, boolean>>;
} {
  const { dispatch, bridge } = useRuntime();
  const [state, setState] = useState<McpServersState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState<Record<string, PendingSignIn>>({});
  const [tests, setTests] = useState<Record<string, McpTestResult>>({});
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const setPendingFor = useCallback((name: string, value: PendingSignIn | undefined) => {
    if (!mounted.current) return;
    setPending((current) => {
      const next = { ...current };
      if (value) next[name] = value;
      else delete next[name];
      return next;
    });
  }, []);

  const signIn = useCallback(
    async (name: string) => {
      const start = await startMcpSignIn(dispatch, name);
      if (start.status === "done") {
        if (mounted.current) setState({ status: "ready", result: start.list });
        return;
      }
      setPendingFor(name, {
        name,
        attemptId: start.attemptId,
        url: start.url,
        ...(start.code ? { code: start.code } : {}),
      });
      try {
        if (start.code) await navigator.clipboard?.writeText(start.code).catch(() => undefined);
        await openExternalLink(bridge, start.url);
        const result = await waitForMcpSignIn(dispatch, start.attemptId);
        if (mounted.current) setState({ status: "ready", result });
      } finally {
        setPendingFor(name, undefined);
      }
    },
    [dispatch, bridge, setPendingFor],
  );

  const cancelSignIn = useCallback(
    (name: string) => {
      const attemptId = pendingRef.current[name]?.attemptId;
      if (attemptId) void cancelMcpSignIn(dispatch, attemptId).catch(() => undefined);
    },
    [dispatch],
  );

  const reopenSignIn = useCallback(
    async (name: string) => {
      const url = pendingRef.current[name]?.url;
      return url ? openExternalLink(bridge, url) : undefined;
    },
    [bridge],
  );

  const signOut = useCallback(
    async (name: string) => {
      const result = await signOutMcpServer(dispatch, name);
      if (mounted.current) setState({ status: "ready", result });
      return result;
    },
    [dispatch],
  );

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

  const setAgentScope = useCallback(
    async (scope: AgentToolScope) => {
      const result = await setAgentToolScope(dispatch, scope);
      setState({ status: "ready", result });
      return result;
    },
    [dispatch],
  );

  const test = useCallback(
    async (name: string) => {
      setTesting((current) => ({ ...current, [name]: true }));
      try {
        const reply = await testMcpServer(dispatch, name);
        if (mounted.current) {
          setTests((current) => ({ ...current, [name]: reply }));
          setState((current) =>
            current.status === "ready"
              ? { status: "ready", result: { ...current.result, health: mergeHealth(current.result.health, reply) } }
              : current,
          );
        }
        return reply;
      } finally {
        if (mounted.current) {
          setTesting((current) => {
            const next = { ...current };
            delete next[name];
            return next;
          });
        }
      }
    },
    [dispatch],
  );

  return {
    state,
    reload: () => setAttempt((value) => value + 1),
    save,
    setAgentAccess,
    setAgentScope,
    signIn,
    cancelSignIn,
    reopenSignIn,
    signOut,
    pending,
    test,
    tests,
    testing,
  };
}
