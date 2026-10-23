import {
  CheckpointDiffResult,
  type CheckpointDiffResult as CheckpointDiffResultValue,
  CheckpointRestoreResult,
  type CheckpointRestoreResult as CheckpointRestoreResultValue,
  type RpcResponse,
} from "@zli-v2/contracts";

import { makeCommandId } from "../runtime/commandId.js";

type Dispatch = (request: unknown) => Promise<RpcResponse | undefined>;

async function request<T>(
  dispatch: Dispatch,
  command: Record<string, unknown>,
  schema: { parse(value: unknown): T },
): Promise<T> {
  const response = await dispatch({ protocolVersion: 1, commandId: makeCommandId(), command });
  if (!response) throw new Error("The runtime is not connected.");
  if (!response.accepted) throw new Error(response.error.message);
  try {
    return schema.parse(response.result);
  } catch {
    throw new Error("The runtime sent an unexpected reply. Restart ZLI and try again.");
  }
}

export function readCheckpointDiff(
  dispatch: Dispatch,
  checkpointId: string,
  path: string,
): Promise<CheckpointDiffResultValue> {
  return request(dispatch, { type: "checkpoint.diff", checkpointId, path }, CheckpointDiffResult);
}

export function restoreCheckpoint(dispatch: Dispatch, checkpointId: string): Promise<CheckpointRestoreResultValue> {
  return request(dispatch, { type: "checkpoint.restore", checkpointId }, CheckpointRestoreResult);
}
