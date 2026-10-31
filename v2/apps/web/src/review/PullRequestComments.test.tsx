// @vitest-environment jsdom

import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { PullRequestComments } from "./PullRequestComments.js";
import { resetPullRequestStoreForTests } from "./pullRequestStore.js";
import {
  buttonByLabel,
  buttonByText,
  cleanupRuntimeRenders,
  pressModEnter,
  type Responder,
  renderWithRuntime,
  typeInto,
  worktree,
} from "./testRuntime.js";

const comments = {
  number: 7,
  url: "https://github.com/acme/app/pull/7",
  threads: [
    {
      id: "PRRT_1",
      path: "src/app.ts",
      line: 4,
      outdated: false,
      comments: [{ id: "PRRC_1", author: "ana", body: "Handle the empty list." }],
      viewerCanReply: true,
      viewerCanResolve: true,
      viewerCanUnresolve: true,
    },
    {
      id: "PRRT_2",
      path: "src/locked.ts",
      line: 1,
      outdated: false,
      comments: [{ author: "bo", body: "Locked conversation." }],
      viewerCanReply: false,
      viewerCanResolve: false,
    },
  ],
  reviews: [],
};

const github: Responder = (command) => {
  switch (command.type) {
    case "review.pr.comments":
      return { result: comments };
    case "review.pr.reply":
      return {
        result: { threadId: command.threadId, comment: { id: "PRRC_9", author: "me", body: command.body } },
      };
    case "review.pr.resolve":
      return { result: { threadId: command.threadId, resolved: command.resolved } };
    case "review.pr.comment":
      return { result: { pullRequest: { number: 7, url: comments.url, state: "OPEN", isDraft: false } } };
    default:
      return { error: "not used here" };
  }
};

afterEach(async () => {
  await cleanupRuntimeRenders();
  resetPullRequestStoreForTests();
});

function render(respond: Responder = github) {
  return renderWithRuntime(<PullRequestComments worktree={worktree} checkKey={0} />, respond);
}

const status = () => document.querySelector(".pr-comments-status")?.textContent;

describe("PullRequestComments replies and resolving", () => {
  it("replies to a thread with Mod+Enter and counts the new reply", async () => {
    const commands = await render();
    expect(status()).toBe("2 open review comments");
    expect(buttonByLabel("Reply on src/locked.ts:1")).toBeUndefined();
    expect(buttonByLabel("Resolve thread on src/locked.ts:1")).toBeUndefined();

    await act(async () => buttonByLabel("Reply on src/app.ts:4")?.click());
    const box = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reply on src/app.ts:4"]');
    expect(box).not.toBeNull();
    expect(document.activeElement).toBe(box);
    await typeInto(box as HTMLTextAreaElement, "Fixed in the next commit.");
    await pressModEnter(box as HTMLTextAreaElement);

    expect(commands.find((command) => command.type === "review.pr.reply")).toMatchObject({
      threadId: "PRRT_1",
      body: "Fixed in the next commit.",
    });
    expect(document.querySelector('textarea[aria-label="Reply on src/app.ts:4"]')).toBeNull();
    expect(document.body.textContent).toContain("1 more reply");
    expect(commands.some((command) => command.type === "review.pr.status")).toBe(true);
  });

  it("keeps the reply box open with the error when GitHub refuses", async () => {
    await render((command) =>
      command.type === "review.pr.reply"
        ? { error: "Your GitHub account is not allowed to change this thread." }
        : github(command),
    );
    await act(async () => buttonByLabel("Reply on src/app.ts:4")?.click());
    const box = document.querySelector<HTMLTextAreaElement>("textarea") as HTMLTextAreaElement;
    await typeInto(box, "ok");
    await act(async () => buttonByText("Reply")?.click());
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("not allowed to change this thread");
    expect(box.value).toBe("ok");
  });

  it("marks a resolved thread, leaves it out of the agent message, and can reopen it", async () => {
    const commands = await render();
    expect(buttonByText("Send 2 to agent")).toBeDefined();
    await act(async () => buttonByLabel("Resolve thread on src/app.ts:4")?.click());

    expect(commands.find((command) => command.type === "review.pr.resolve")).toMatchObject({
      threadId: "PRRT_1",
      resolved: true,
    });
    expect(document.body.textContent).toContain("Resolved");
    expect(status()).toBe("1 open review comment");
    expect(buttonByText("Send 1 to agent")).toBeDefined();
    expect(buttonByLabel("Reply on src/app.ts:4")).toBeUndefined();

    await act(async () => buttonByLabel("Unresolve thread on src/app.ts:4")?.click());
    expect(commands.filter((command) => command.type === "review.pr.resolve").at(-1)).toMatchObject({
      resolved: false,
    });
    expect(status()).toBe("2 open review comments");
  });

  it("adds a comment to the pull request conversation", async () => {
    const commands = await render();
    await act(async () => buttonByText("Comment")?.click());
    const box = document.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Comment on pull request #7"]',
    ) as HTMLTextAreaElement;
    await typeInto(box, "Merging after CI.");
    await act(async () => buttonByText("Add comment")?.click());
    expect(commands.find((command) => command.type === "review.pr.comment")).toMatchObject({
      body: "Merging after CI.",
    });
    expect(status()).toBe("Comment added to #7.");
  });
});
