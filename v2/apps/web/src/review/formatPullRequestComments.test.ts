import type { PullRequestReviewSummary, PullRequestReviewThread } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import { formatPullRequestCommentsMessage, threadLocation } from "./formatPullRequestComments.js";

const PR = { number: 7, url: "https://github.com/acme/app/pull/7" };

const THREAD: PullRequestReviewThread = {
  id: "T1",
  path: "src/app.ts",
  line: 14,
  startLine: 12,
  outdated: false,
  diffHunk: "@@ -10,3 +10,5 @@\n const a = 1;\n+const b = ```x```;",
  comments: [
    { author: "ana", body: "Handle the empty list." },
    { author: "bo", body: "Agreed." },
  ],
};

const REVIEW: PullRequestReviewSummary = { id: "R1", author: "ana", state: "CHANGES_REQUESTED", body: "Needs tests." };

describe("threadLocation", () => {
  it("names the line range, a single line, or only the file", () => {
    expect(threadLocation(THREAD)).toBe("src/app.ts:12-14");
    expect(threadLocation({ path: "a.ts", line: 3 })).toBe("a.ts:3");
    expect(threadLocation({ path: "a.ts" })).toBe("a.ts");
  });
});

describe("formatPullRequestCommentsMessage", () => {
  it("lists reviews, then threads with their diff lines and every reply", () => {
    const message = formatPullRequestCommentsMessage(PR, [THREAD], [REVIEW], "feature");
    expect(message).toBe(
      [
        "Please address these review comments from pull request #7 for the branch feature.\nhttps://github.com/acme/app/pull/7",
        "Review by ana (requested changes):\nNeeds tests.",
        [
          "src/app.ts:12-14",
          "````diff",
          "@@ -10,3 +10,5 @@",
          " const a = 1;",
          "+const b = ```x```;",
          "````",
          "ana: Handle the empty list.",
          "bo: Agreed.",
        ].join("\n"),
      ].join("\n\n"),
    );
  });

  it("marks outdated threads and leaves out a missing hunk", () => {
    const message = formatPullRequestCommentsMessage(
      PR,
      [{ ...THREAD, outdated: true, diffHunk: undefined, comments: [{ author: "bo", body: "x".repeat(5_000) }] }],
      [],
      undefined,
    );
    expect(message.startsWith("Please address this review comment from pull request #7.")).toBe(true);
    expect(message).toContain("src/app.ts:12-14 (outdated: the code changed after this comment)");
    expect(message).not.toContain("```");
    expect(message).toContain(`bo: ${"x".repeat(4_000)}…`);
  });
});
