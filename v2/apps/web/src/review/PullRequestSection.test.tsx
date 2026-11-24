// @vitest-environment jsdom

import type { PullRequestStatusResult } from "@zli-v2/contracts";
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { forgeWords } from "./forgeWords.js";
import { PullRequestSection } from "./PullRequestSection.js";
import { cleanupRuntimeRenders, renderWithRuntime, worktree } from "./testRuntime.js";

afterEach(async () => {
  await cleanupRuntimeRenders();
});

const base: PullRequestStatusResult = {
  branch: "feature",
  uncommittedFiles: 0,
  defaults: { title: "Add login", body: "", base: "main" },
};
const gitlab = {
  kind: "gitlab" as const,
  label: "GitLab",
  requestNoun: "merge request" as const,
  host: "gitlab.com",
  capabilities: {
    checks: true,
    checkLog: false,
    reviewThreads: false,
    review: false,
    autoMerge: false,
    mergeMethods: ["merge" as const, "squash" as const],
  },
};

async function show(status: PullRequestStatusResult) {
  await renderWithRuntime(
    <PullRequestSection worktree={worktree} base={undefined} checkKey={0} onCommitFirst={() => undefined} />,
    () => ({ result: status }),
  );
  await act(async () => undefined);
  return document.querySelector(".review-pr, .review-pr-quiet")?.textContent ?? "";
}

describe("PullRequestSection on each forge", () => {
  it("speaks GitLab's words and offers only what glab can do", async () => {
    const text = await show({
      ...base,
      forge: gitlab,
      pullRequest: { number: 7, url: "https://gitlab.com/acme/app/-/merge_requests/7", state: "OPEN", isDraft: false },
    });
    expect(text).toContain("!7");
    expect(text).toContain("View MR");
    expect(text).toContain("Merge MR");
    expect(text).not.toContain("Review comments");
    expect(text).not.toContain("Review");
  });

  it("keeps the Create dialog open when Changes draws the section again elsewhere", async () => {
    await show(base);
    const create = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "Create PR",
    );
    await act(async () => create?.click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    // Drawn anew, as when a refresh moves it between Changes' two spots.
    await cleanupRuntimeRenders();
    await show(base);
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    const cancel = [...(dialog?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
      (b) => b.textContent === "Cancel",
    );
    await act(async () => cancel?.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("offers Create MR when the branch has none", async () => {
    const text = await show({ ...base, forge: gitlab });
    expect(text).toContain("No merge request for this branch yet");
    expect(text).toContain("Create MR");
  });

  it("shows a missing CLI as a card that leads to Settings → Forges", async () => {
    const text = await show({
      ...base,
      forge: gitlab,
      problem: { code: "cli_missing", message: "GitLab needs glab, which is not installed." },
    });
    expect(text).toContain("GitLab isn't connected");
    expect(text).toContain("GitLab needs glab");
    expect(document.querySelector(".review-pr-setup .connector-logo svg")).not.toBeNull();
    expect([...document.querySelectorAll("button")].some((button) => button.textContent === "Forges")).toBe(true);
  });

  it("names an unknown forge plainly and offers no pull request actions", async () => {
    const text = await show({
      ...base,
      problem: { code: "unknown_forge", message: "ZLI can't tell which forge git.corp.example is on." },
    });
    expect(text).toContain("Unknown forge");
    expect(text).not.toContain("Create PR");
  });

  it("keeps GitHub's words when an older runtime does not name the forge", () => {
    expect(forgeWords(undefined)).toMatchObject({ label: "GitHub", short: "PR", sign: "#" });
  });
});

describe("PullRequestSection without a remote", () => {
  it("offers to publish the repository", async () => {
    const text = await show({ ...base, problem: { code: "no_origin", message: "No origin." } });
    expect(text).toContain("Not on a forge yet");
    expect([...document.querySelectorAll("button")].some((button) => button.textContent === "Publish")).toBe(true);
  });
});
