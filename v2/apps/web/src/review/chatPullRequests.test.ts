import type { PullRequestInfo, ThreadMessageProjection } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import { chatPullRequestLinks, stackState } from "./chatPullRequests.js";

const message = (threadId: string, role: ThreadMessageProjection["role"], text: string) =>
  ({ messageId: `${threadId}-${text.length}`, threadId, role, text }) as ThreadMessageProjection;

const pr = (number: number, checks: NonNullable<PullRequestInfo["checks"]>, state: PullRequestInfo["state"] = "OPEN") =>
  ({ number, url: `https://github.com/o/r/pull/${number}`, state, isDraft: false, checks }) as PullRequestInfo;

describe("a chat's pull requests", () => {
  it("lists the links the chat's agents wrote, newest first, each once, and none from other chats or the person", () => {
    const links = chatPullRequestLinks(
      [
        message("a", "assistant", "Opened https://github.com/o/r/pull/161 and https://github.com/o/r/pull/162."),
        message("b", "assistant", "Another chat: https://github.com/o/r/pull/999"),
        message("a", "user", "What about https://github.com/o/r/pull/500?"),
        message("a", "assistant", "Updated https://github.com/o/r/pull/161, then https://github.com/o/r/pull/171"),
      ],
      new Set(["a"]),
    );
    expect(links).toEqual([
      "https://github.com/o/r/pull/171",
      "https://github.com/o/r/pull/161",
      "https://github.com/o/r/pull/162",
    ]);
  });

  it("colours a stack by its worst open pull request", () => {
    const passed = pr(1, [{ name: "ci", state: "passed" }]);
    const running = pr(2, [{ name: "ci", state: "pending" }]);
    const failed = pr(3, [{ name: "ci", state: "failed" }]);
    const mergedFailure = pr(4, [{ name: "ci", state: "failed" }], "MERGED");
    expect(stackState([passed, mergedFailure])).toBe("passed");
    expect(stackState([passed, running])).toBe("pending");
    expect(stackState([passed, running, failed])).toBe("failed");
    expect(stackState([])).toBe("none");
  });
});
