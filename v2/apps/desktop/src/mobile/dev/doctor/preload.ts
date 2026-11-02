import {
  MobileAgentsBlockResult,
  MobileDoctorCheckInput,
  MobileDoctorDeep,
  MobileDoctorDeepPlan,
  MobileDoctorInput,
  MobileDoctorProposeFixInput,
  MobileProjectFacts,
  MobileProposal,
} from "@zli-v2/contracts";

import type { PreloadIpc } from "../preloadIpc.js";

/** window.zli.mobile.dev.doctor. Part of the preload bundle, so it imports only contracts and preload files. */
export function createDoctorApi(ipc: PreloadIpc) {
  const worktree = (worktreeId: string) => MobileDoctorInput.parse({ worktreeId });
  return {
    doctor: {
      check: async (worktreeId: string, options: { refresh?: boolean } = {}) =>
        MobileProjectFacts.parse(
          await ipc.invoke(
            "zli:mobile:doctor:check",
            MobileDoctorCheckInput.parse({ worktreeId, ...(options.refresh ? { refresh: true } : {}) }),
          ),
        ),
      deepPlan: async (worktreeId: string) =>
        MobileDoctorDeepPlan.parse(await ipc.invoke("zli:mobile:doctor:deep-plan", worktree(worktreeId))),
      deepRun: async (worktreeId: string) =>
        MobileDoctorDeep.parse(await ipc.invoke("zli:mobile:doctor:deep-run", worktree(worktreeId))),
      proposeBlock: async (worktreeId: string) =>
        MobileAgentsBlockResult.parse(await ipc.invoke("zli:mobile:doctor:propose-block", worktree(worktreeId))),
      proposeFix: async (worktreeId: string, findingId: string) =>
        MobileProposal.parse(
          await ipc.invoke(
            "zli:mobile:doctor:propose-fix",
            MobileDoctorProposeFixInput.parse({ worktreeId, findingId }),
          ),
        ),
    },
  };
}
