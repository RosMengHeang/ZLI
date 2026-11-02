import type {
  MobileAgentsBlockResult,
  MobileDoctorDeep,
  MobileDoctorDeepPlan,
  MobileProjectFacts,
  MobileProposal,
} from "@zli-v2/contracts";

/** window.zli.mobile.dev.doctor: the Toolchain group's view of a worktree's app. */
export type DoctorApi = {
  check(worktreeId: string, options?: { refresh?: boolean }): Promise<MobileProjectFacts>;
  /** The exact Expo check lines, shown before anything runs. */
  deepPlan(worktreeId: string): Promise<MobileDoctorDeepPlan>;
  /** Runs the Expo checks, which execute the project's code. Only the Run button calls it. */
  deepRun(worktreeId: string): Promise<MobileDoctorDeep>;
  /** Creates the AGENTS.md block proposal, or says the block is already current. Writes nothing. */
  proposeBlock(worktreeId: string): Promise<MobileAgentsBlockResult>;
  /** Creates a proposal from a finding's fix. Runs nothing. */
  proposeFix(worktreeId: string, findingId: string): Promise<MobileProposal>;
};

export type DoctorBridge = { doctor?: DoctorApi };
