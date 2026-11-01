import {
  MobileCheckPackageInput,
  type MobilePackageCheck,
  MobilePackagesInput,
  type MobileProposal,
  proposalCommandLine,
} from "@zli-v2/contracts";

import { BrowserControlError } from "../../../browser/BrowserControlActions.js";
import { projectFacts } from "../doctor/facts.js";
import type { MobileDevFeature, MobileDevHost } from "../host.js";
import { createDirectory } from "./directory.js";
import { installAction, verdictFor } from "./rules.js";

/** F3, the package guard: React Native Directory checks before an install, and the install command as a proposal. */
export function createPackages(host: MobileDevHost): MobileDevFeature {
  const directory = createDirectory(host);

  const check = async (worktreeId: string, packages: readonly string[]): Promise<MobilePackageCheck> => {
    const facts = await projectFacts(host, worktreeId);
    if (!facts) throw new BrowserControlError("ZLI does not know this worktree.", 404);
    const names = [...new Set(packages)];
    const entries = await directory.lookup(names);
    const verdicts = names.map((name) => {
      const base = name.indexOf("@", name.startsWith("@") ? 1 : 0);
      return verdictFor(name, entries.get(base === -1 ? name : name.slice(0, base)), facts);
    });
    const install = installAction(
      verdicts.filter((verdict) => verdict.verdict !== "block").map((verdict) => verdict.name),
      facts,
    );
    return {
      verdicts,
      ...(install?.kind === "command" ? { install, command: proposalCommandLine(install) } : {}),
    };
  };

  const proposeInstall = async (worktreeId: string, packages: readonly string[]): Promise<MobileProposal> => {
    const result = await check(worktreeId, packages);
    const install = result.install;
    if (install?.kind !== "command") {
      throw new Error(
        result.verdicts.every((verdict) => verdict.verdict === "block")
          ? "Every package was blocked, so there is nothing to install."
          : "This app does not install npm packages.",
      );
    }
    const kept = result.verdicts.filter((verdict) => verdict.verdict !== "block").map((verdict) => verdict.name);
    const blocked = result.verdicts.filter((verdict) => verdict.verdict === "block").map((verdict) => verdict.name);
    const line = proposalCommandLine(install);
    const waiting = host.proposals
      .list(worktreeId)
      .find(
        (proposal) =>
          proposal.state === "pending" &&
          proposal.action.kind === "command" &&
          proposal.action.cwd === install.cwd &&
          proposalCommandLine(proposal.action) === line,
      );
    if (waiting) return waiting;
    const reason = [
      "Checked against React Native Directory.",
      install.program === "npx" ? "npx expo install picks versions that match this Expo SDK." : "",
      blocked.length > 0 ? `Left out because they were blocked: ${blocked.join(", ")}.` : "",
    ]
      .filter(Boolean)
      .join(" ");
    return host.proposals.create({
      worktreeId,
      source: "zli",
      sourceLabel: "From the project check",
      title: (kept.length === 1 ? `Install ${kept[0]}` : `Install ${kept.length} packages`).slice(0, 120),
      reason: reason.slice(0, 600),
      action: install,
    });
  };

  return {
    actions: {
      mobilecheckpackage: async (input, context) => {
        const parsed = MobileCheckPackageInput.parse(input);
        return check(context.worktreeFor(parsed).worktreeId, parsed.packages);
      },
    },
    ipc: {
      "zli:mobile:packages:check": (input) => {
        const parsed = MobilePackagesInput.parse(input);
        return check(parsed.worktreeId, parsed.packages);
      },
      "zli:mobile:packages:propose-install": (input) => {
        const parsed = MobilePackagesInput.parse(input);
        return proposeInstall(parsed.worktreeId, parsed.packages);
      },
    },
    decorate: undefined,
    testOps: {},
    dispose() {},
  };
}
