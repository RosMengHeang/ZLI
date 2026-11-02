import { createBuildApi } from "./mobile/dev/build/preload.js";
import { createConditionsApi } from "./mobile/dev/conditions/preload.js";
import { createCrashApi } from "./mobile/dev/crash/preload.js";
import { createDoctorApi } from "./mobile/dev/doctor/preload.js";
import { createPackagesApi } from "./mobile/dev/packages/preload.js";
import type { PreloadIpc } from "./mobile/dev/preloadIpc.js";
import { createProposalApi } from "./mobile/dev/proposalPreload.js";
import { createWorkspaceApi } from "./mobile/dev/workspace/preload.js";

/** window.zli.mobile.dev: the proposals API, and whatever each mobile dev feature adds beside it. */
export function createMobileDevApi(ipc: PreloadIpc) {
  return {
    proposals: createProposalApi(ipc),
    ...createWorkspaceApi(ipc),
    ...createDoctorApi(ipc),
    ...createPackagesApi(ipc),
    ...createCrashApi(ipc),
    ...createBuildApi(ipc),
    ...createConditionsApi(ipc),
  };
}
