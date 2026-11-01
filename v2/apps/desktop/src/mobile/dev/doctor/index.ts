import {
  MobileControlDoctorInput,
  MobileDoctorCheckInput,
  MobileDoctorInput,
  MobileDoctorProposeFixInput,
  type MobileProjectFacts,
  type MobileProposal,
  proposalCommandLine,
} from "@zli-v2/contracts";

import { BrowserControlError } from "../../../browser/BrowserControlActions.js";
import type { MobileDevFeature, MobileDevHost } from "../host.js";
import { proposeBlock } from "./agentsBlock.js";
import { deepPlan, runDeep } from "./deepCheck.js";
import { projectFacts } from "./facts.js";
import { fixTitleFor } from "./knownIssues.js";

/** F2, the mobile doctor: project facts for agents and the Toolchain group, Expo checks on a click, and the notes block. */
export function createDoctor(host: MobileDevHost): MobileDevFeature {
  const factsFor = async (worktreeId: string, refresh?: boolean): Promise<MobileProjectFacts> => {
    const facts = await projectFacts(host, worktreeId, refresh ? { refresh } : {});
    if (!facts) throw new Error("That worktree is not in ZLI.");
    return facts;
  };

  const proposeFix = async (worktreeId: string, findingId: string): Promise<MobileProposal> => {
    const facts = await factsFor(worktreeId);
    const finding = facts.findings.find((entry) => entry.id === findingId);
    if (!finding) throw new Error("ZLI no longer finds that problem. Check again to see the current list.");
    const fix = finding.fix;
    if (fix?.kind !== "command") throw new Error("ZLI has no command to propose for that problem.");
    const line = proposalCommandLine(fix);
    const waiting = host.proposals
      .list(worktreeId)
      .find(
        (proposal) =>
          proposal.state === "pending" &&
          proposal.action.kind === "command" &&
          proposal.action.cwd === fix.cwd &&
          proposalCommandLine(proposal.action) === line,
      );
    if (waiting) return waiting;
    return host.proposals.create({
      worktreeId,
      source: "zli",
      sourceLabel: "From the project check",
      title: (fixTitleFor(findingId, facts) ?? `Fix: ${finding.title}`).slice(0, 120),
      reason: finding.detail.slice(0, 600),
      action: fix,
    });
  };

  return {
    actions: {
      mobiledoctor: async (input, context) => {
        const parsed = MobileControlDoctorInput.parse(input);
        const worktree = context.worktreeFor(parsed);
        const facts = await projectFacts(host, worktree.worktreeId, parsed.refresh ? { refresh: true } : {});
        if (!facts) throw new BrowserControlError("ZLI does not know this worktree.", 404);
        return facts;
      },
    },
    ipc: {
      "zli:mobile:doctor:check": (input) => {
        const parsed = MobileDoctorCheckInput.parse(input);
        return factsFor(parsed.worktreeId, parsed.refresh);
      },
      "zli:mobile:doctor:deep-plan": (input) => deepPlan(host, MobileDoctorInput.parse(input).worktreeId),
      // The Expo checks run the project's own code, so only the Run button in the Toolchain group calls this.
      "zli:mobile:doctor:deep-run": (input) => runDeep(host, MobileDoctorInput.parse(input).worktreeId),
      "zli:mobile:doctor:propose-block": async (input) => {
        const { worktreeId } = MobileDoctorInput.parse(input);
        return proposeBlock(host, worktreeId, await factsFor(worktreeId));
      },
      "zli:mobile:doctor:propose-fix": (input) => {
        const parsed = MobileDoctorProposeFixInput.parse(input);
        return proposeFix(parsed.worktreeId, parsed.findingId);
      },
    },
    decorate: undefined,
    testOps: {},
    dispose() {},
  };
}
