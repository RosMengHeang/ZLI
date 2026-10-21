import { ProjectConfigResult, type SharedPrompt } from "@zli-v2/contracts";
import { useEffect, useState } from "react";

import { makeCommandId } from "../runtime/commandId.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";

export type SharedPrompts = { prompts: readonly SharedPrompt[]; error?: string };

const EMPTY: SharedPrompts = { prompts: [] };
/** The last answer per project, shown at once while a fresh read of zli.json is in flight. */
const lastKnown = new Map<string, SharedPrompts>();

/** Prompts from the project's zli.json. Read fresh each time a picker or manager opens. */
export function useSharedPrompts(projectId: string | undefined): SharedPrompts {
  const { dispatch } = useRuntime();
  const [state, setState] = useState<SharedPrompts>(() => (projectId ? (lastKnown.get(projectId) ?? EMPTY) : EMPTY));

  useEffect(() => {
    if (!projectId) {
      setState(EMPTY);
      return;
    }
    setState(lastKnown.get(projectId) ?? EMPTY);
    let cancelled = false;
    void dispatch({ protocolVersion: 1, commandId: makeCommandId(), command: { type: "project.config", projectId } })
      .then((response) => {
        if (!response || response.accepted === false) return;
        const parsed = ProjectConfigResult.safeParse(response.result);
        if (!parsed.success) return;
        const next: SharedPrompts =
          parsed.data.status === "valid"
            ? { prompts: parsed.data.config.prompts ?? [] }
            : parsed.data.status === "invalid"
              ? { prompts: [], error: parsed.data.message }
              : EMPTY;
        lastKnown.set(projectId, next);
        if (!cancelled) setState(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [dispatch, projectId]);

  return state;
}
