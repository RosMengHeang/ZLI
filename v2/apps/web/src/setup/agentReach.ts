import type { AgentReachRequest } from "@zli-v2/contracts";
import { useCallback, useEffect, useState } from "react";

import type { ZliBridge } from "../runtime/bridge.js";

/** The open question from an agent that wants to reach other projects, and a way to answer it. */
export function useAgentReach(bridge: ZliBridge | undefined): {
  request: AgentReachRequest | undefined;
  /** Resolves with a problem to show when the answer did not go through. */
  answer(allow: boolean): Promise<string | undefined>;
} {
  const [request, setRequest] = useState<AgentReachRequest>();
  useEffect(() => {
    const reach = bridge?.agentReach;
    if (!reach) return;
    // A question asked before the window loaded is still waiting, unless news of a later one came first.
    let takeCurrent = true;
    const off = reach.onRequest((next) => {
      takeCurrent = false;
      setRequest(next);
    });
    void reach
      .current()
      .then((current) => {
        if (takeCurrent) setRequest(current);
      })
      .catch(() => undefined);
    return () => {
      takeCurrent = false;
      off();
    };
  }, [bridge]);

  const answer = useCallback(
    async (allow: boolean) => {
      const reach = bridge?.agentReach;
      if (!request || !reach) return undefined;
      try {
        await reach.answer({ requestId: request.requestId, allow });
        setRequest((current) => (current?.requestId === request.requestId ? undefined : current));
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    [bridge, request],
  );
  return { request, answer };
}
