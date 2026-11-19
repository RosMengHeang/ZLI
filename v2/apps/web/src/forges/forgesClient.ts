import { ForgeStatusResult } from "@zli-v2/contracts";

import type { Dispatch } from "../issues/issuesClient.js";
import { makeCommandId } from "../runtime/commandId.js";

async function forgeRequest(dispatch: Dispatch, type: "forges.status" | "forges.rescan"): Promise<ForgeStatusResult> {
  const response = await dispatch({ protocolVersion: 1, commandId: makeCommandId(), command: { type } });
  if (!response) throw new Error("ZLI is not connected to its runtime.");
  if (!response.accepted) throw new Error(response.error.message);
  const parsed = ForgeStatusResult.safeParse(response.result);
  if (!parsed.success) throw new Error("The runtime sent an unexpected reply. Restart ZLI and try again.");
  return parsed.data;
}

/** Each forge CLI's status, as the runtime last checked it. */
export function forgesStatus(dispatch: Dispatch): Promise<ForgeStatusResult> {
  return forgeRequest(dispatch, "forges.status");
}

/** Checks every forge CLI again. */
export function rescanForges(dispatch: Dispatch): Promise<ForgeStatusResult> {
  return forgeRequest(dispatch, "forges.rescan");
}
