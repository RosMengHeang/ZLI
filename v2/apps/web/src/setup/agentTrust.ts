import type { RuntimeProjection } from "@zli-v2/contracts";
import { type RefObject, useCallback, useRef, useState } from "react";

type Waiting = { promise: Promise<boolean>; resolve(trusted: boolean): void };

/**
 * Asks once per project whether agents may work there, before the first agent starts in it.
 * Launches that arrive while the question is open wait for the same answer.
 */
export function useAgentTrust(projectionRef: RefObject<RuntimeProjection | undefined>) {
  const waiting = useRef(new Map<string, Waiting>());
  /** Answered yes here, possibly before the projection shows it. */
  const trusted = useRef(new Set<string>());
  const [asking, setAsking] = useState<string>();

  const ensureTrusted = useCallback(
    (projectId: string): Promise<boolean> => {
      const project = projectionRef.current?.projects.find((entry) => entry.projectId === projectId);
      if (project?.agentsTrusted === true || trusted.current.has(projectId)) return Promise.resolve(true);
      const open = waiting.current.get(projectId);
      if (open) return open.promise;
      let resolve: (trusted: boolean) => void = () => undefined;
      const promise = new Promise<boolean>((done) => {
        resolve = done;
      });
      waiting.current.set(projectId, { promise, resolve });
      setAsking((current) => current ?? projectId);
      return promise;
    },
    [projectionRef],
  );

  const answer = useCallback((projectId: string, yes: boolean) => {
    if (yes) trusted.current.add(projectId);
    const open = waiting.current.get(projectId);
    waiting.current.delete(projectId);
    open?.resolve(yes);
    setAsking(waiting.current.keys().next().value);
  }, []);

  return { asking, ensureTrusted, answer };
}

export const AGENTS_NOT_TRUSTED =
  "Agents start in this project only after you let them work here. Try again to answer the question.";
