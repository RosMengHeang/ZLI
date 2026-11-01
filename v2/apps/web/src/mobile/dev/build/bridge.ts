import type { MobileBuildBrief, MobileBuildProposeInput, MobileProposal } from "@zli-v2/contracts";

/** window.zli.mobile.dev.build: the build brief for a pasted log. */
export type BuildBridge = {
  build: {
    brief(worktreeId: string, log: string): Promise<MobileBuildBrief>;
    /** Creates a proposal card for the brief's command. It still runs only from Run in terminal. */
    propose(input: MobileBuildProposeInput): Promise<MobileProposal>;
  };
};
