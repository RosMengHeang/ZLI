import {
  MOBILE_BUILD_LOG_MAX,
  MobileBuildBriefInput,
  MobileBuildPanelInput,
  MobileBuildProposeInput,
} from "@zli-v2/contracts";

import { BrowserControlError } from "../../../browser/BrowserControlActions.js";
import type { MobileDevFeature, MobileDevHost } from "../host.js";
import { ProposalError } from "../ProposalStore.js";
import { buildBrief } from "./brief.js";
import { type LogFiles, LogPathError, nodeLogFiles, readBuildLog } from "./logPath.js";

/** The build brief: classifies a failed build log and says what to check first. It reads, and never runs a build. */
export function createBuild(host: MobileDevHost, options: { files?: LogFiles } = {}): MobileDevFeature {
  const files = options.files ?? nodeLogFiles;
  const worktreePath = (worktreeId: string) => {
    const found = host.worktreePath(worktreeId);
    if (!found) throw new Error("That worktree is not in ZLI.");
    return found;
  };
  return {
    actions: {
      mobilebuildbrief: async (input, context) => {
        const parsed = MobileBuildBriefInput.safeParse(input);
        if (!parsed.success)
          throw new BrowserControlError(parsed.error.issues[0]?.message ?? "Pass either log or logPath.", 400);
        const worktree = context.worktreeFor(parsed.data);
        let log = parsed.data.log;
        let logCut = false;
        if (log === undefined) {
          try {
            const read = await readBuildLog(parsed.data.logPath ?? "", worktree.path, files);
            log = read.text;
            logCut = read.cut;
          } catch (cause) {
            if (cause instanceof LogPathError) throw new BrowserControlError(cause.message, cause.status);
            throw cause;
          }
        }
        return buildBrief(host, worktree.worktreeId, log.slice(-MOBILE_BUILD_LOG_MAX), { logCut });
      },
    },
    ipc: {
      "zli:mobile:build:brief": (input) => {
        const parsed = MobileBuildPanelInput.parse(input);
        worktreePath(parsed.worktreeId);
        return buildBrief(host, parsed.worktreeId, parsed.log);
      },
      "zli:mobile:build:propose": (input) => {
        const parsed = MobileBuildProposeInput.parse(input);
        if (parsed.action.kind !== "command") throw new Error("The build brief proposes commands only.");
        try {
          return host.proposals.create({
            worktreeId: parsed.worktreeId,
            source: "zli",
            sourceLabel: "From the build brief",
            title: parsed.title ?? "Fix the build",
            reason: parsed.reason ?? "",
            action: parsed.action,
          });
        } catch (cause) {
          if (cause instanceof ProposalError) throw new Error(cause.message);
          throw cause;
        }
      },
    },
    decorate: undefined,
    testOps: {},
    dispose() {},
  };
}
