import { HuddleName } from "@zli-v2/contracts";
import { useMemo } from "react";

import { makeCommandId } from "../runtime/commandId.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";

export type HuddleCommands = {
  /** Sends a huddle command. Resolves with the runtime's reason when it refuses, or undefined. */
  run(command: Record<string, unknown>): Promise<string | undefined>;
  /** Creates a huddle and resolves with its id, or with the reason it could not be created. */
  create(name: string, members?: readonly string[]): Promise<{ huddleId: string } | { error: string }>;
};

/** Huddle commands go through the same dispatch as every other runtime command. */
export function useHuddleCommands(): HuddleCommands {
  const { dispatch } = useRuntime();
  return useMemo(() => {
    const run = async (command: Record<string, unknown>): Promise<string | undefined> => {
      try {
        const response = await dispatch({ protocolVersion: 1, commandId: makeCommandId(), command });
        if (!response) return "The runtime is not connected.";
        return response.accepted === false ? response.error.message : undefined;
      } catch (cause) {
        return cause instanceof Error ? cause.message : "The huddle command failed.";
      }
    };
    const create = async (name: string, members?: readonly string[]) => {
      const parsed = HuddleName.safeParse(name);
      if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Give the huddle a name." };
      const huddleId = crypto.randomUUID();
      const error = await run({
        type: "huddle.create",
        huddleId,
        name: parsed.data,
        ...(members && members.length > 0 ? { members: [...members] } : {}),
      });
      return error ? { error } : { huddleId };
    };
    return { run, create };
  }, [dispatch]);
}
