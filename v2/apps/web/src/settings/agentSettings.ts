import { AgentSettings, type RpcResponse } from "@zli-v2/contracts";
import { useCallback, useEffect, useState } from "react";

import { makeCommandId } from "../runtime/commandId.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";

type Dispatch = (request: unknown) => Promise<RpcResponse | undefined>;

/** Choices for when Claude summarizes older context. Undefined keeps Claude Code's own setting. */
export const AUTO_COMPACT_CHOICES: ReadonlyArray<{ tokens: number | undefined; label: string }> = [
  { tokens: undefined, label: "Claude's default" },
  { tokens: 100_000, label: "100k tokens" },
  { tokens: 200_000, label: "200k tokens" },
  { tokens: 400_000, label: "400k tokens" },
];

async function send(dispatch: Dispatch, command: unknown): Promise<AgentSettings> {
  const response = await dispatch({ protocolVersion: 1, commandId: makeCommandId(), command });
  if (!response) throw new Error("ZLI is not connected to its runtime.");
  if (!response.accepted) throw new Error(response.error.message);
  const parsed = AgentSettings.safeParse(response.result);
  if (!parsed.success) throw new Error("The runtime sent an unexpected reply.");
  return parsed.data;
}

export const readAgentSettings = (dispatch: Dispatch) => send(dispatch, { type: "agentSettings.read" });
export const saveAgentSettings = (dispatch: Dispatch, settings: AgentSettings) =>
  send(dispatch, { type: "agentSettings.save", settings });

export type AgentSettingsState =
  | { status: "loading" }
  | { status: "ready"; settings: AgentSettings; saveError?: string }
  | { status: "error"; message: string };

/** The runtime's agent settings, and a save that shows the result once the runtime has it. */
export function useAgentSettings(): {
  state: AgentSettingsState;
  save: (settings: AgentSettings) => Promise<void>;
} {
  const { dispatch } = useRuntime();
  const [state, setState] = useState<AgentSettingsState>({ status: "loading" });
  useEffect(() => {
    let live = true;
    readAgentSettings(dispatch).then(
      (settings) => live && setState({ status: "ready", settings }),
      (error: unknown) =>
        live && setState({ status: "error", message: error instanceof Error ? error.message : String(error) }),
    );
    return () => {
      live = false;
    };
  }, [dispatch]);
  const save = useCallback(
    async (settings: AgentSettings) => {
      try {
        setState({ status: "ready", settings: await saveAgentSettings(dispatch, settings) });
      } catch (error) {
        setState((current) =>
          current.status === "ready"
            ? { ...current, saveError: error instanceof Error ? error.message : String(error) }
            : current,
        );
      }
    },
    [dispatch],
  );
  return { state, save };
}
