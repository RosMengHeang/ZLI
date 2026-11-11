import type { PullRequestInfo } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import { checksSummary, followUpsIn, reviewFindings } from "./ChatExtras.js";
import { chatTranscript } from "./chatDrag.js";

describe("followUpsIn", () => {
  it("lists the items under a Next steps heading", () => {
    const reply = [
      "Done. The login page works.",
      "",
      "## Next steps",
      "",
      "- Add a **password reset** flow",
      "- Write tests for `login.ts`",
      "",
      "Let me know.",
    ].join("\n");
    expect(followUpsIn(reply)).toEqual(["Add a password reset flow", "Write tests for login.ts"]);
  });

  it("finds bold and numbered follow-ups and stops at four", () => {
    const reply =
      "**Follow-ups:**\n1. One thing to do\n2. Two thing to do\n3. Three thing\n4. Four thing\n5. Five thing";
    expect(followUpsIn(reply)).toHaveLength(4);
  });

  it("offers nothing without such a heading", () => {
    expect(followUpsIn("- just a list\n- of things")).toEqual([]);
  });
});

describe("reviewFindings", () => {
  it("reads list items that name a file and line", () => {
    const reply = [
      "Found two problems:",
      "- `src/app.ts:12` misses a null check",
      "- src/routes.ts:40 – the handler swallows errors",
      "- Overall this looks fine",
    ].join("\n");
    expect(reviewFindings(reply)).toEqual([
      { file: "src/app.ts", line: 12, text: "misses a null check" },
      { file: "src/routes.ts", line: 40, text: "the handler swallows errors" },
    ]);
  });

  it("needs two findings to make a review", () => {
    expect(reviewFindings("- `src/app.ts:12` misses a null check")).toEqual([]);
  });
});

describe("checksSummary", () => {
  const pullRequest = (states: Array<"passed" | "failed" | "pending" | "skipped">) =>
    ({
      number: 1,
      url: "https://github.com/a/b/pull/1",
      state: "OPEN",
      isDraft: false,
      checks: states.map((state, index) => ({ name: `check-${index}`, state })),
    }) as PullRequestInfo;

  it("says failed when any check failed, ignoring skipped ones", () => {
    expect(checksSummary(pullRequest(["passed", "failed", "skipped"]))).toEqual({
      state: "failed",
      failed: 1,
      total: 2,
    });
  });

  it("says running while one is pending and passed when all pass", () => {
    expect(checksSummary(pullRequest(["passed", "pending"])).state).toBe("pending");
    expect(checksSummary(pullRequest(["passed", "passed"])).state).toBe("passed");
    expect(checksSummary(pullRequest([])).state).toBe("none");
  });
});

describe("chatTranscript", () => {
  it("writes the person and the agent in order under the chat title", () => {
    const text = chatTranscript("Fix login", [
      { messageId: "1", threadId: "t", role: "user", text: "Fix the login" },
      { messageId: "2", threadId: "t", role: "assistant", text: "Fixed it." },
      { messageId: "3", threadId: "t", role: "system", text: "ignored" },
    ] as never);
    expect(text).toBe('# Context from the chat "Fix login"\n\n## User\n\nFix the login\n\n## Agent\n\nFixed it.');
  });
});
