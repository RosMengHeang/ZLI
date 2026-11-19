import type { ForgeCapabilities, ForgeInfo, PullRequestProblem } from "@zli-v2/contracts";

/** How the Changes panel names a forge and its requests: "GitLab", "merge request", "MR", "!7". */
export type ForgeWords = {
  kind: ForgeInfo["kind"];
  label: string;
  host: string | undefined;
  /** "pull request" or "merge request". */
  noun: string;
  /** "Pull request" or "Merge request". */
  Noun: string;
  /** "PR" or "MR", for buttons. */
  short: string;
  /** What comes before a request's number: # on GitHub and Gitea, ! on GitLab. */
  sign: "#" | "!";
  capabilities: ForgeCapabilities;
};

const GITHUB: ForgeInfo = {
  kind: "github",
  label: "GitHub",
  requestNoun: "pull request",
  capabilities: {
    checks: true,
    checkLog: true,
    reviewThreads: true,
    review: true,
    autoMerge: true,
    mergeMethods: ["squash", "merge", "rebase"],
  },
};

/** The words for `forge`; a runtime too old to say which forge it is only knew GitHub. */
export function forgeWords(forge: ForgeInfo | undefined): ForgeWords {
  const info = forge ?? GITHUB;
  const merge = info.requestNoun === "merge request";
  return {
    kind: info.kind,
    label: info.label,
    host: info.host,
    noun: info.requestNoun,
    Noun: merge ? "Merge request" : "Pull request",
    short: merge ? "MR" : "PR",
    sign: info.kind === "gitlab" ? "!" : "#",
    capabilities: info.capabilities,
  };
}

/** Problems the person fixes in a terminal or in Settings → Forges, not by trying again. */
export function isSetupProblem(problem: PullRequestProblem | undefined): boolean {
  return (
    !!problem &&
    [
      "gh_missing",
      "gh_unauthenticated",
      "cli_missing",
      "cli_outdated",
      "cli_unauthenticated",
      "unknown_forge",
    ].includes(problem.code)
  );
}
