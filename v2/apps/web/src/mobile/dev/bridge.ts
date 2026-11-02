import type { MobileProposal } from "@zli-v2/contracts";

import type { BuildBridge } from "./build/bridge.js";
import type { CrashBridge } from "./crash/bridge.js";
import type { DoctorBridge } from "./doctor/bridge.js";
import type { PackagesBridge } from "./packages/bridge.js";
import type { WorkspaceBridge } from "./workspace/bridge.js";

/** Commands and file changes waiting for the person. Accept and dismiss take only an id. */
export type ProposalsBridge = {
  list(worktreeId?: string): Promise<MobileProposal[]>;
  /** Runs the command in a new terminal, or writes the file block. The result says whether it started or failed. */
  accept(proposalId: string): Promise<MobileProposal>;
  dismiss(proposalId: string): Promise<MobileProposal>;
  /** Fires with every proposal, for every worktree, whenever one changes. */
  onChange(listener: (proposals: MobileProposal[]) => void): () => void;
};

/** window.zli.mobile.dev: proposals, and what each mobile dev feature adds beside them. */
export type MobileDevBridge = { proposals: ProposalsBridge } & WorkspaceBridge &
  DoctorBridge &
  PackagesBridge &
  CrashBridge &
  BuildBridge;
