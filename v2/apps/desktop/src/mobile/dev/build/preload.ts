import { MobileBuildBrief, MobileBuildPanelInput, MobileBuildProposeInput, MobileProposal } from "@zli-v2/contracts";

import type { PreloadIpc } from "../preloadIpc.js";

/** The project view's Build failure group: explain a pasted log, and propose the brief's first command. */
export function createBuildApi(ipc: PreloadIpc) {
  return {
    build: {
      brief: async (worktreeId: string, log: string) =>
        MobileBuildBrief.parse(
          await ipc.invoke("zli:mobile:build:brief", MobileBuildPanelInput.parse({ worktreeId, log })),
        ),
      propose: async (input: MobileBuildProposeInput) =>
        MobileProposal.parse(await ipc.invoke("zli:mobile:build:propose", MobileBuildProposeInput.parse(input))),
    },
  };
}
