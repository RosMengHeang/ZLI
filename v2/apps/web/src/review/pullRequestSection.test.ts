import type { PullRequestInfo } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import { checksSummary, formatCheckMessage } from "./PullRequestSection.js";

const PR: PullRequestInfo = {
  number: 7,
  url: "https://github.com/acme/app/pull/7",
  state: "OPEN",
  isDraft: false,
};

describe("checksSummary", () => {
  it("names failures, then pending, then the pass count", () => {
    expect(checksSummary([{ name: "a", state: "failed" }])).toEqual({ text: "1 check failed", tone: "danger" });
    expect(
      checksSummary([
        { name: "a", state: "passed" },
        { name: "b", state: "pending" },
      ]),
    ).toEqual({ text: "1 check running", tone: "warning" });
    expect(
      checksSummary([
        { name: "a", state: "passed" },
        { name: "b", state: "passed" },
        { name: "c", state: "skipped" },
      ]),
    ).toEqual({ text: "2 passed, 1 skipped", tone: "success" });
    expect(checksSummary([{ name: "a", state: "skipped" }])).toEqual({ text: "No checks ran", tone: "neutral" });
  });
});

describe("formatCheckMessage", () => {
  const check = {
    name: "verify (ubuntu-latest)",
    workflow: "ZLI V2 desktop",
    state: "failed" as const,
    url: "https://github.com/acme/app/actions/runs/5/job/9",
  };

  it("names the check, the pull request, and the failed step's log", () => {
    const message = formatCheckMessage(check, PR, "feature", { excerpt: "FAIL src/app.test.ts", truncated: true });
    expect(message).toContain('check "verify (ubuntu-latest)" (workflow "ZLI V2 desktop") failed');
    expect(message).toContain("pull request #7");
    expect(message).toContain("feature");
    expect(message).toContain("(earlier lines left out)");
    expect(message).toContain("FAIL src/app.test.ts");
  });

  it("says when the log had nothing to show", () => {
    const message = formatCheckMessage(check, PR, "feature", { excerpt: "", truncated: false });
    expect(message).toContain("no readable output");
    expect(message).not.toContain("```");
  });
});
