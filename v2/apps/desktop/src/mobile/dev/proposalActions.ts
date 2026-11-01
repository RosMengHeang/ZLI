import {
  MobileControlProposeInput,
  MobileProposalIdInput,
  MobileProposalListInput,
  MobileTestProposeFileInput,
  MobileTestProposeInput,
} from "@zli-v2/contracts";

import { BrowserControlError } from "../../browser/BrowserControlActions.js";
import type { MobileDevFeature, MobileDevHost } from "./host.js";
import { ProposalError, proposalDigest } from "./ProposalStore.js";

const AGENT_REPLY =
  "ZLI shows this command to the person in the Mobile panel with Run in terminal and Dismiss. Nothing runs until they choose Run. Do not run it yourself; carry on with other work, or tell the person what the command is for.";

/** Proposals: the mobile_propose agent action, the card's IPC channels, and the e2e operations that create them. */
export function createProposalFeature(host: MobileDevHost): MobileDevFeature {
  const { proposals } = host;
  const testWorktree = (worktreeId: string | undefined) => {
    const worktrees = host.worktrees();
    const worktree = worktreeId
      ? worktrees.find((entry) => entry.worktreeId === worktreeId)
      : (worktrees.find((entry) => entry.status === "ready") ?? worktrees[0]);
    if (!worktree) throw new Error("No worktree to propose in.");
    return worktree;
  };
  return {
    actions: {
      mobilepropose: async (input, context) => {
        const parsed = MobileControlProposeInput.parse(input);
        const worktree = context.worktreeFor(parsed);
        const owner = context.ownerFor(parsed);
        try {
          const proposal = proposals.create({
            worktreeId: worktree.worktreeId,
            source: "agent",
            sourceLabel: `Proposed by ${lowerFirst(owner.ownerLabel)}`,
            title: parsed.title,
            reason: parsed.reason,
            action: { kind: "command", program: parsed.program, args: parsed.args, cwd: parsed.folder ?? "." },
          });
          return { proposalId: proposal.proposalId, state: proposal.state, message: AGENT_REPLY };
        } catch (cause) {
          if (cause instanceof ProposalError) throw new BrowserControlError(cause.message, cause.status);
          throw cause;
        }
      },
    },
    ipc: {
      "zli:mobile:proposals:list": (input) => proposals.list(MobileProposalListInput.parse(input ?? {}).worktreeId),
      "zli:mobile:proposals:accept": (input) => proposals.accept(MobileProposalIdInput.parse(input).proposalId),
      "zli:mobile:proposals:dismiss": (input) => proposals.dismiss(MobileProposalIdInput.parse(input).proposalId),
    },
    decorate: undefined,
    testOps: {
      propose: (input) => {
        const parsed = MobileTestProposeInput.parse(input);
        const worktree = testWorktree(parsed.worktreeId);
        return proposals.create({
          worktreeId: worktree.worktreeId,
          source: "agent",
          sourceLabel: `Proposed by the agent in ${baseName(worktree.path)}`,
          title: parsed.title,
          reason: parsed.reason,
          action: { kind: "command", program: parsed.program, args: parsed.args, cwd: parsed.folder ?? "." },
        });
      },
      "propose-file": async (input) => {
        const parsed = MobileTestProposeFileInput.parse(input);
        const worktree = testWorktree(parsed.worktreeId);
        const existing = await host.fs.readFile(`${worktree.path}/${parsed.file}`).catch(() => undefined);
        return proposals.create({
          worktreeId: worktree.worktreeId,
          source: "zli",
          sourceLabel: "From the project check",
          title: parsed.title,
          reason: parsed.reason,
          action: {
            kind: "file-block",
            file: parsed.file,
            marker: "zli:mobile",
            content: parsed.content,
            baseDigest: proposalDigest(existing),
          },
        });
      },
    },
    dispose() {},
  };
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function baseName(path: string): string {
  return path.replaceAll("\\", "/").split("/").filter(Boolean).pop() ?? path;
}
