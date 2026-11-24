import {
  type AgentServer,
  AgentServersResult,
  type DevServerProjection,
  type RuntimeProjection,
  type TerminalProjection,
  type ThreadActivityProjection,
  type ThreadProjection,
  worktreeDevServers,
} from "@zli-v2/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { makeCommandId } from "../runtime/commandId.js";
import { useRuntime, useRuntimeSelector } from "../runtime/RuntimeProvider.js";
import type { IconName } from "../ui/Icon.js";

/** One thing the chat has running: a server, an app, or a command the agent is waiting on. */
export type RunningEntry = {
  id: string;
  icon: IconName;
  /** The address for a server, else the command. */
  name: string;
  /** Where it came from: the terminal's title or the command that printed the address. */
  detail?: string | undefined;
  url?: string | undefined;
  status: "starting" | "running" | "exited";
  /** The ZLI terminal that runs it, which ZLI can stop. Absent when the agent owns the process. */
  terminalId?: string | undefined;
};

/** A command shorter than this is a quick step, not something left running. */
export const LONG_COMMAND_MS = 5_000;
/** How long something that stopped stays on the card, marked as exited. */
export const EXITED_SHOWN_MS = 10_000;
/** How often the agent's own servers are checked while the card shows. */
const AGENT_SERVER_POLL_MS = 4_000;

/** Commands that start a desktop or mobile app rather than a server or a script. */
const APP_COMMAND =
  /\b(?:electron(?:-forge|-vite)?|tauri|wails|flutter run|expo (?:start|run)|react-native run|dotnet run|cargo run|xcodebuild|gradlew|run-android|run-ios)\b/iu;
const LOCAL_ADDRESS = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):\d/u;

export function hostOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return url;
  }
}

function commandIcon(command: string): IconName {
  return APP_COMMAND.test(command) ? "monitor" : "terminal";
}

/** True when a chat step printed a local address, so its agent may have started a server worth checking. */
export function mayHaveAgentServer(activities: readonly ThreadActivityProjection[]): boolean {
  return activities.some(
    (activity) => activity.kind === "command" && !!activity.detail && LOCAL_ADDRESS.test(activity.detail),
  );
}

/**
 * What runs for the chat right now, from three real sources: servers ZLI's own terminals in the worktree
 * announced (checked by the runtime and stoppable), servers the chat's agent started from its shell tool and
 * that still answer, and the agent's commands that have run for a while and not finished.
 */
export function runningEntries({
  devServers,
  terminals,
  agentServers,
  activities,
  threadStatus,
  now,
}: {
  devServers: readonly DevServerProjection[];
  terminals: readonly TerminalProjection[];
  agentServers: readonly AgentServer[];
  activities: readonly ThreadActivityProjection[];
  threadStatus: ThreadProjection["status"] | undefined;
  now: number;
}): RunningEntry[] {
  const entries: RunningEntry[] = [];
  const ports = new Set<number>();
  for (const server of devServers) {
    const terminal = terminals.find((candidate) => candidate.terminalId === server.terminalId);
    ports.add(server.port);
    entries.push({
      id: `terminal:${server.terminalId}:${server.port}`,
      icon: "globe",
      name: hostOf(server.url),
      detail: terminal?.title,
      url: server.url,
      status: terminal?.status === "starting" ? "starting" : "running",
      terminalId: server.terminalId,
    });
  }
  const serving = new Set<string>();
  for (const server of agentServers) {
    if (ports.has(server.port)) continue;
    ports.add(server.port);
    serving.add(server.activityId);
    entries.push({
      id: `agent:${server.port}`,
      icon: server.command && APP_COMMAND.test(server.command) ? "monitor" : "globe",
      name: hostOf(server.url),
      detail: server.command ?? server.title,
      url: server.url,
      status: "running",
    });
  }
  // A step still marked running after its agent stopped did not finish; it was cut off with the turn.
  const live = threadStatus === "working" || threadStatus === "starting" || threadStatus === "waiting";
  if (live) {
    for (const activity of activities) {
      if (activity.kind !== "command" || activity.status !== "running" || serving.has(activity.activityId)) continue;
      const started = activity.startedAt ? Date.parse(activity.startedAt) : undefined;
      if (started !== undefined && now - started < LONG_COMMAND_MS) continue;
      const command = activity.command ?? activity.title;
      entries.push({
        id: `step:${activity.activityId}`,
        icon: commandIcon(command),
        name: command,
        detail: activity.command && activity.title !== activity.command ? activity.title : undefined,
        status: "running",
      });
    }
  }
  return entries;
}

const EMPTY_SERVERS: readonly AgentServer[] = [];

/** The servers the chat's agent started itself, checked while the card shows and the chat printed an address. */
function useAgentServers(threadIds: string, enabled: boolean): readonly AgentServer[] {
  const { dispatch } = useRuntime();
  const [servers, setServers] = useState<readonly AgentServer[]>(EMPTY_SERVERS);
  useEffect(() => {
    if (!enabled || !threadIds) {
      setServers(EMPTY_SERVERS);
      return;
    }
    let live = true;
    let timer: number | undefined;
    const check = async () => {
      try {
        const response = await dispatch({
          protocolVersion: 1,
          commandId: makeCommandId(),
          command: { type: "devserver.agentServers", threadIds: threadIds.split(" ").slice(-20) },
        });
        if (!live) return;
        const parsed = response?.accepted ? AgentServersResult.safeParse(response.result) : undefined;
        // A runtime that cannot answer shows nothing rather than a guess.
        const next = parsed?.success ? parsed.data.servers : EMPTY_SERVERS;
        setServers((current) => (sameServers(current, next) ? current : next));
      } catch {
        if (live) setServers(EMPTY_SERVERS);
      }
      if (live) timer = window.setTimeout(() => void check(), AGENT_SERVER_POLL_MS);
    };
    void check();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [dispatch, threadIds, enabled]);
  return servers;
}

function sameServers(left: readonly AgentServer[], right: readonly AgentServer[]): boolean {
  return (
    left.length === right.length &&
    left.every((server, index) => server.url === right[index]?.url && server.activityId === right[index]?.activityId)
  );
}

const EMPTY_DEV_SERVERS: readonly DevServerProjection[] = [];
const EMPTY_TERMINALS: readonly TerminalProjection[] = [];

/**
 * The chat's running entries, with each one that stops kept a short while as exited so the change is seen.
 * `chainKey` is the chat's thread ids joined by spaces.
 */
export function useRunning({
  worktreeId,
  chainKey,
  activities,
  threadStatus,
}: {
  worktreeId: string | undefined;
  chainKey: string;
  activities: readonly ThreadActivityProjection[];
  threadStatus: ThreadProjection["status"] | undefined;
}): RunningEntry[] {
  const allDevServers = useRuntimeSelector(
    useCallback((value: RuntimeProjection | undefined) => value?.devServers ?? EMPTY_DEV_SERVERS, []),
  );
  const terminals = useRuntimeSelector(
    useCallback((value: RuntimeProjection | undefined) => value?.terminals ?? EMPTY_TERMINALS, []),
  );
  const devServers = useMemo(() => worktreeDevServers(allDevServers, worktreeId), [allDevServers, worktreeId]);
  const agentServers = useAgentServers(chainKey, mayHaveAgentServer(activities));
  const [now, setNow] = useState(() => Date.now());
  const current = runningEntries({ devServers, terminals, agentServers, activities, threadStatus, now });

  // Entries that stopped since the last render, with when they stopped.
  const gone = useRef(new Map<string, { entry: RunningEntry; at: number }>());
  const seen = useRef(new Map<string, RunningEntry>());
  const ids = new Set(current.map((entry) => entry.id));
  for (const [id, entry] of seen.current) {
    if (!ids.has(id) && !gone.current.has(id)) gone.current.set(id, { entry: { ...entry, status: "exited" }, at: now });
  }
  for (const entry of current) gone.current.delete(entry.id);
  seen.current = new Map(current.map((entry) => [entry.id, entry]));
  for (const [id, { at }] of gone.current) if (now - at >= EXITED_SHOWN_MS) gone.current.delete(id);

  // A command crosses the long-running line, or an exited entry is due to go: render again then.
  const waitingCommand =
    (threadStatus === "working" || threadStatus === "starting" || threadStatus === "waiting") &&
    activities.some(
      (activity) =>
        activity.kind === "command" &&
        activity.status === "running" &&
        activity.startedAt !== undefined &&
        now - Date.parse(activity.startedAt) < LONG_COMMAND_MS,
    );
  const hasGone = gone.current.size > 0;
  useEffect(() => {
    if (!waitingCommand && !hasGone) return;
    const timer = window.setTimeout(() => setNow(Date.now()), 1_000);
    return () => window.clearTimeout(timer);
  });

  return [...current, ...[...gone.current.values()].map((item) => item.entry)];
}
