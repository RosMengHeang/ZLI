import { useMemo } from "react";

import { useRuntimeSelector } from "../runtime/RuntimeProvider.js";
import { type RunGroup, type RunState, runReplied, runState } from "./bestOf.js";
import type { AgentSession } from "./sessions.js";

/**
 * Live state of every run in the groups. It reads chat messages, which the shell projection lets go
 * stale, so it subscribes on its own and re-renders only when a run's state changes.
 */
export function useRunStates(groups: readonly RunGroup[], sessions: readonly AgentSession[]): Map<string, RunState> {
  const key = useRuntimeSelector((projection) =>
    groups
      .flatMap((group) => group.sessionIds)
      .map((sessionId) => {
        const session = sessions.find((entry) => entry.sessionId === sessionId);
        return `${sessionId}=${runState(session, runReplied(projection?.messages, session?.thread?.threadId))}`;
      })
      .join(" "),
  );
  return useMemo(
    () =>
      new Map(
        key
          .split(" ")
          .filter(Boolean)
          .map((entry) => entry.split("=") as [string, RunState]),
      ),
    [key],
  );
}

/** Every run in the group stopped working, so the group can be compared. */
export function groupFinished(group: RunGroup, states: ReadonlyMap<string, RunState>): boolean {
  return group.sessionIds.every((sessionId) => (states.get(sessionId) ?? "running") !== "running");
}
