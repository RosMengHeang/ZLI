// @vitest-environment jsdom

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReviewPullRequestDialog } from "./ReviewPullRequestDialog.js";
import {
  buttonByText,
  cleanupRuntimeRenders,
  pressModEnter,
  type Responder,
  renderWithRuntime,
  typeInto,
  worktree,
} from "./testRuntime.js";

const pullRequest = { number: 7, url: "https://github.com/acme/app/pull/7", state: "OPEN" as const, isDraft: false };

afterEach(cleanupRuntimeRenders);

const reviewed: Responder = () => ({ result: { pullRequest: { ...pullRequest, reviewDecision: "APPROVED" } } });

function render(onReviewed: (result: unknown) => void, respond: Responder = reviewed) {
  return renderWithRuntime(
    <ReviewPullRequestDialog
      worktree={worktree}
      pullRequest={pullRequest}
      onClose={() => undefined}
      onReviewed={onReviewed}
    />,
    respond,
  );
}

const textarea = () => document.querySelector<HTMLTextAreaElement>("textarea") as HTMLTextAreaElement;

describe("ReviewPullRequestDialog", () => {
  it("needs a comment before sending a comment review, then sends it with Mod+Enter", async () => {
    const onReviewed = vi.fn();
    const commands = await render(onReviewed);
    expect(buttonByText("Submit review")?.disabled).toBe(true);
    await pressModEnter(textarea());
    expect(commands).toHaveLength(0);

    await typeInto(textarea(), "Looks close, one question inline.");
    expect(buttonByText("Submit review")?.disabled).toBe(false);
    await pressModEnter(textarea());

    expect(commands.at(-1)).toMatchObject({
      type: "review.pr.review",
      event: "COMMENT",
      body: "Looks close, one question inline.",
    });
    expect(onReviewed).toHaveBeenCalledWith({ pullRequest: { ...pullRequest, reviewDecision: "APPROVED" } });
  });

  it("approves without a comment", async () => {
    const commands = await render(() => undefined);
    await act(async () => buttonByText("Approve")?.click());
    expect(document.body.textContent).toContain("Comment (optional)");
    expect(document.body.textContent).toContain("Runs gh pr review --approve.");
    await act(async () => buttonByText("Submit review")?.click());
    expect(commands.at(-1)).toMatchObject({ type: "review.pr.review", event: "APPROVE", body: "" });
  });

  it("requires a comment to request changes and shows what GitHub said", async () => {
    const onReviewed = vi.fn();
    await render(onReviewed, () => ({
      error: "GitHub does not let you request changes on your own pull request. Leave a comment instead.",
    }));
    await act(async () => buttonByText("Request changes")?.click());
    expect(buttonByText("Submit review")?.disabled).toBe(true);
    await typeInto(textarea(), "Handle the empty list.");
    await act(async () => buttonByText("Submit review")?.click());

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "GitHub does not let you request changes on your own pull request.",
    );
    expect(onReviewed).not.toHaveBeenCalled();
    expect(buttonByText("Submit review")?.disabled).toBe(false);
  });
});
