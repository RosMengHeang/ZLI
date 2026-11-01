import type { MobilePackageCheck, MobileProposal } from "@zli-v2/contracts";

/** window.zli.mobile.dev.packages: React Native Directory checks and the install proposal. */
export type PackagesApi = {
  check(worktreeId: string, packages: string[]): Promise<MobilePackageCheck>;
  /** Creates a proposal that installs the packages that were not blocked. Runs nothing. */
  proposeInstall(worktreeId: string, packages: string[]): Promise<MobileProposal>;
};

export type PackagesBridge = { packages?: PackagesApi };
