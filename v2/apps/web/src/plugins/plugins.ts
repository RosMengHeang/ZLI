import {
  type PluginAction,
  PluginContributions,
  PluginInstallPreview,
  PluginInstallResult,
  PluginListResult,
  type RpcResponse,
} from "@zli-v2/contracts";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { makeCommandId } from "../runtime/commandId.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";

type Dispatch = (request: unknown) => Promise<RpcResponse | undefined>;
type Schema<T> = { safeParse(value: unknown): { success: true; data: T } | { success: false } };

async function request<T>(dispatch: Dispatch, command: Record<string, unknown>, schema: Schema<T>): Promise<T> {
  const response = await dispatch({ protocolVersion: 1, commandId: makeCommandId(), command });
  if (!response) throw new Error("ZLI is not connected to its runtime.");
  if (!response.accepted) throw new Error(response.error.message);
  const parsed = schema.safeParse(response.result);
  if (!parsed.success) throw new Error("The runtime sent an unexpected reply. Restart ZLI and try again.");
  return parsed.data;
}

export function listPlugins(dispatch: Dispatch): Promise<PluginListResult> {
  return request(dispatch, { type: "plugins.list" }, PluginListResult);
}

export function previewPluginInstall(dispatch: Dispatch, source: string): Promise<PluginInstallPreview> {
  return request(dispatch, { type: "plugins.previewInstall", source }, PluginInstallPreview);
}

export function installPlugins(dispatch: Dispatch, source: string, names: readonly string[]) {
  return request(dispatch, { type: "plugins.install", source, names }, PluginInstallResult);
}

export function setPluginEnabled(dispatch: Dispatch, name: string, enabled: boolean) {
  return request(dispatch, { type: "plugins.setEnabled", name, enabled }, PluginListResult);
}

export function configurePlugin(dispatch: Dispatch, name: string, values: Record<string, string>) {
  return request(dispatch, { type: "plugins.configure", name, values }, PluginListResult);
}

export function updatePlugin(dispatch: Dispatch, name: string) {
  return request(dispatch, { type: "plugins.update", name }, PluginListResult);
}

export function removePlugin(dispatch: Dispatch, name: string) {
  return request(dispatch, { type: "plugins.remove", name }, PluginListResult);
}

/** "2 skills, 1 MCP server" for a plugin's parts, or undefined when it has none. */
export function componentSummary(components: {
  skills: readonly unknown[];
  mcpServers: readonly unknown[];
  prompts: readonly unknown[];
  actions: readonly unknown[];
}): string | undefined {
  const count = (n: number, one: string, many: string) => (n === 0 ? [] : [`${n} ${n === 1 ? one : many}`]);
  const parts = [
    ...count(components.skills.length, "skill", "skills"),
    ...count(components.mcpServers.length, "MCP server", "MCP servers"),
    ...count(components.prompts.length, "prompt", "prompts"),
    ...count(components.actions.length, "action", "actions"),
  ];
  return parts.length > 0 ? parts.join(", ") : undefined;
}

export const formatLabel = { zli: "ZLI", claude: "Claude Code", codex: "Codex", folder: "Folder" } as const;

export type PluginsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; result: PluginListResult };

export function usePlugins(): {
  state: PluginsState;
  reload(): void;
  dispatch: Dispatch;
  apply(work: (dispatch: Dispatch) => Promise<PluginListResult>): Promise<PluginListResult>;
} {
  const { dispatch } = useRuntime();
  const [state, setState] = useState<PluginsState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is the retry trigger.
  useEffect(() => {
    let cancelled = false;
    setState((current) => (current.status === "ready" ? current : { status: "loading" }));
    listPlugins(dispatch)
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

  const apply = useCallback(
    async (work: (dispatch: Dispatch) => Promise<PluginListResult>) => {
      const result = await work(dispatch);
      setState({ status: "ready", result });
      void refreshPluginContributions(dispatch);
      return result;
    },
    [dispatch],
  );

  return { state, reload: () => setAttempt((value) => value + 1), dispatch, apply };
}

const EMPTY: PluginContributions = { prompts: [], actions: [] };
let contributions: PluginContributions = EMPTY;
const listeners = new Set<() => void>();

/** Reads the prompts and actions of enabled plugins again and tells every view that shows them. */
export async function refreshPluginContributions(dispatch: Dispatch): Promise<void> {
  try {
    contributions = await request(dispatch, { type: "plugins.contributions" }, PluginContributions);
  } catch {
    return;
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Plugin prompts and actions. Read again whenever `refreshKey` changes, so a list that opens is current. */
export function usePluginContributions(refreshKey: unknown = undefined): PluginContributions {
  const { dispatch } = useRuntime();
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey asks for a fresh read.
  useEffect(() => {
    void refreshPluginContributions(dispatch);
  }, [dispatch, refreshKey]);
  return useSyncExternalStore(
    subscribe,
    () => contributions,
    () => EMPTY,
  );
}

/**
 * The terminal that runs one plugin action in a worktree. A login shell on Unix so PATH matches the
 * person's terminal, and cmd.exe on Windows, as for zli.json setup commands.
 */
export function actionTerminalCommand(
  action: PluginAction,
  worktree: { worktreeId: string; path: string },
  windows = typeof navigator !== "undefined" && navigator.userAgent.includes("Windows"),
) {
  return {
    type: "terminal.create" as const,
    terminalId: makeCommandId(),
    worktreeId: worktree.worktreeId,
    cwd: worktree.path,
    title: action.name,
    cols: 120,
    rows: 24,
    ...(windows
      ? { shell: "cmd.exe", args: ["/d", "/s", "/c", `"${action.command}"`] }
      : { shell: "/bin/bash", args: ["-lc", action.command] }),
  };
}
