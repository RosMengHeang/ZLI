import { ProjectBranchResult, type RpcResponse } from "@zli-v2/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { makeCommandId } from "../runtime/commandId.js";

type Dispatch = (request: unknown) => Promise<RpcResponse | undefined>;

/** What is known about a folder's branch: still being read, could not be read, or what git said. */
export type BranchRead = { status: "loading" } | { status: "failed" } | { status: "done"; result: ProjectBranchResult };

/** Asks the runtime which branch the project folder has checked out. Undefined when it could not say. */
export async function readProjectBranch(
  dispatch: Dispatch,
  projectId: string,
): Promise<ProjectBranchResult | undefined> {
  try {
    const response = await dispatch({
      protocolVersion: 1,
      commandId: makeCommandId(),
      command: { type: "project.branch", projectId },
    });
    return response?.accepted ? ProjectBranchResult.safeParse(response.result).data : undefined;
  } catch {
    return undefined;
  }
}

/** Reads the branch and reports the outcome as a BranchRead. */
export async function readBranchState(dispatch: Dispatch, projectId: string): Promise<BranchRead> {
  const result = await readProjectBranch(dispatch, projectId);
  return result ? { status: "done", result } : { status: "failed" };
}

/** The project folder's branch, read once per project and again on retry. Undefined when nothing is asked. */
export function useProjectBranch(
  dispatch: Dispatch | undefined,
  projectId: string | undefined,
): { read: BranchRead | undefined; retry(): void } {
  const [state, setState] = useState<{ projectId: string; read: BranchRead }>();
  const [attempt, setAttempt] = useState(0);
  // A caller can pass a new dispatch each render; only a different project or a retry reads the folder again.
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;
  const asking = dispatch !== undefined && projectId !== undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is the retry trigger.
  useEffect(() => {
    const send = dispatchRef.current;
    if (!send || !projectId) return;
    let live = true;
    setState({ projectId, read: { status: "loading" } });
    void readBranchState(send, projectId).then((read) => {
      if (live) setState({ projectId, read });
    });
    return () => {
      live = false;
    };
  }, [projectId, asking, attempt]);
  const retry = useCallback(() => setAttempt((count) => count + 1), []);
  const read =
    asking && state?.projectId === projectId ? state.read : asking ? { status: "loading" as const } : undefined;
  return { read, retry };
}
