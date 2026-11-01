import type { MobileProjectFactsCore } from "@zli-v2/contracts";

import type { MobileDevHost } from "../host.js";

/**
 * What the doctor knows about a worktree's app: its stack, versions, and findings. Placeholder until stream S2
 * replaces this file; it returns undefined, which callers such as the build brief (S3) must treat as "not known".
 */
export async function projectFacts(
  _host: MobileDevHost,
  _worktreeId: string,
): Promise<MobileProjectFactsCore | undefined> {
  return undefined;
}
