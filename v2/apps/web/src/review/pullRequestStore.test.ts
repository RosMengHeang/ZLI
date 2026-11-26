import type { PullRequestStatusResult } from "@zli-v2/contracts";
import { afterEach, describe, expect, it } from "vitest";

import type { Dispatch } from "./pullRequestClient.js";
import {
  pullRequestEntry,
  pullRequestTriggers,
  recordPullRequest,
  refreshPullRequest,
  resetPullRequestStoreForTests,
  staleAfter,
} from "./pullRequestStore.js";

const STATUS: PullRequestStatusResult = {
  branch: "feature",
  uncommittedFiles: 0,
  defaults: { title: "feature", body: "", base: "main" },
  pullRequest: { number: 7, url: "https://github.com/acme/app/pull/7", state: "OPEN", isDraft: false },
};

function accepted(result: unknown) {
  return { protocolVersion: 1, commandId: "c", accepted: true, result } as never;
}

describe("pullRequestStore", () => {
  afterEach(() => resetPullRequestStoreForTests());

  it("shares one lookup between callers", async () => {
    let calls = 0;
    const dispatch: Dispatch = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return accepted(STATUS);
    };
    await Promise.all([
      refreshPullRequest(dispatch, "11111111-1111-4111-8111-111111111111"),
      refreshPullRequest(dispatch, "11111111-1111-4111-8111-111111111111"),
    ]);
    expect(calls).toBe(1);
    expect(pullRequestEntry("11111111-1111-4111-8111-111111111111")?.status?.pullRequest?.number).toBe(7);
    expect(pullRequestEntry("11111111-1111-4111-8111-111111111111")?.checking).toBe(false);
  });

  it("keeps the last answer when a later check fails", async () => {
    let fail = false;
    const dispatch: Dispatch = async () => {
      if (fail) {
        return { protocolVersion: 1, commandId: "c", accepted: false, error: { message: "offline" } } as never;
      }
      return accepted(STATUS);
    };
    await refreshPullRequest(dispatch, "11111111-1111-4111-8111-111111111111");
    fail = true;
    await refreshPullRequest(dispatch, "11111111-1111-4111-8111-111111111111", true);
    expect(pullRequestEntry("11111111-1111-4111-8111-111111111111")?.status?.pullRequest?.number).toBe(7);
    expect(pullRequestEntry("11111111-1111-4111-8111-111111111111")?.error).toBe("offline");
  });

  it("records a pull request that was just created", async () => {
    const dispatch: Dispatch = async () => accepted(STATUS);
    await refreshPullRequest(dispatch, "11111111-1111-4111-8111-111111111111");
    recordPullRequest("11111111-1111-4111-8111-111111111111", {
      number: 8,
      url: "https://github.com/acme/app/pull/8",
      state: "OPEN",
      isDraft: true,
    });
    expect(pullRequestEntry("11111111-1111-4111-8111-111111111111")?.status?.pullRequest?.number).toBe(8);
  });

  it("checks running checks again sooner than quiet branches", () => {
    const pullRequest = STATUS.pullRequest;
    if (!pullRequest) throw new Error("test fixture needs a pull request");
    const pending = {
      status: { ...STATUS, pullRequest: { ...pullRequest, checks: [{ name: "test", state: "pending" as const }] } },
      checking: false,
    };
    const passed = {
      status: { ...STATUS, pullRequest: { ...pullRequest, checks: [{ name: "test", state: "passed" as const }] } },
      checking: false,
    };
    expect(staleAfter(pending)).toBeLessThan(staleAfter(passed));
    // A pull request CI has not picked up yet is looked at as soon as one with checks running.
    const noChecksYet = { status: { ...STATUS, pullRequest: { ...pullRequest, checks: [] } }, checking: false };
    expect(staleAfter(noChecksYet)).toBe(staleAfter(pending));
  });

  it("checks a pushed branch without a pull request sooner than one never pushed", () => {
    const { pullRequest: _pullRequest, ...withoutPullRequest } = STATUS;
    const pushed = {
      status: { ...withoutPullRequest, commitsAhead: 2, upstream: { name: "origin/feature", ahead: 0, behind: 0 } },
      checking: false,
    };
    const local = { status: withoutPullRequest, checking: false };
    expect(staleAfter(pushed)).toBeLessThan(staleAfter(local));
  });
});

describe("pullRequestTriggers", () => {
  const threads = [{ threadId: "t1", worktreeId: "w1" }] as never;
  const command = (id: string, line: string, status: "running" | "completed" = "completed") => ({
    activityId: id,
    threadId: "t1",
    kind: "command" as const,
    title: "Run a command",
    command: line,
    status,
  });

  it("lists finished gh pr create and git push steps and replies that link a pull request", () => {
    const key = pullRequestTriggers({
      threads,
      activities: [
        command("a1", 'gh pr create --title "x" --body "y"'),
        command("a2", "git push -u origin feature"),
        command("a3", "gh pr create", "running"),
        command("a4", "npm test"),
      ],
      messages: [
        { messageId: "m1", threadId: "t1", role: "assistant", text: "Opened https://github.com/acme/app/pull/180." },
        { messageId: "m2", threadId: "t1", role: "assistant", text: "Done." },
      ],
    } as never);
    expect(key.split("\n")).toEqual(["w1 a1", "w1 a2", "w1 m1"]);
  });

  it("is empty without a projection", () => {
    expect(pullRequestTriggers(undefined)).toBe("");
  });
});
