import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";

import { expect, test } from "@playwright/test";

import { closeDesktop, createGitFixture, type DesktopFixture, git, launchDesktop } from "./desktop-fixtures.js";

const PR_URL = "https://github.com/zli/fixture/pull/7";

// Stands in for the GitHub CLI: signed in, no pull request until `gh pr create` runs, and every call logged.
// Reviews and auto-merge rewrite pr.json the way GitHub would report them on the next `gh pr view`.
const FAKE_GH = `#!/bin/sh
state="$ZLI_FAKE_GH_STATE"
printf '%s\\n' "$*" >> "$state/calls.log"
edit_pr() {
  sed "$1" "$state/pr.json" > "$state/pr.next" && mv "$state/pr.next" "$state/pr.json"
}
case "$1" in
  --version) echo "gh version 2.0.0 (fake)"; exit 0 ;;
  auth) exit 0 ;;
  pr)
    case "$2" in
      view)
        if [ -f "$state/pr.json" ]; then cat "$state/pr.json"; exit 0; fi
        echo "no pull requests found for branch \\"$3\\"" >&2
        exit 1 ;;
      create)
        draft=false
        for arg in "$@"; do [ "$arg" = "--draft" ] && draft=true; done
        printf '{"url":"${PR_URL}","state":"OPEN","isDraft":%s,"number":7}' "$draft" > "$state/pr.json"
        echo "${PR_URL}"
        exit 0 ;;
      review)
        [ "$4" = "--approve" ] && edit_pr 's/"reviewDecision":"[A-Z_]*"/"reviewDecision":"APPROVED"/'
        exit 0 ;;
      comment) exit 0 ;;
      merge)
        case "$*" in
          *--disable-auto*) edit_pr 's/"autoMergeRequest":{[^}]*}/"autoMergeRequest":null/'; exit 0 ;;
          *--auto*) edit_pr 's/"autoMergeRequest":null/"autoMergeRequest":{"mergeMethod":"SQUASH"}/'; exit 0 ;;
        esac ;;
    esac ;;
  api)
    case "$*" in
      *addPullRequestReviewThreadReply*)
        printf '%s' '{"data":{"addPullRequestReviewThreadReply":{"comment":{"id":"C9","author":{"login":"me"},"body":"Thanks, fixed."}}}}'
        exit 0 ;;
      *unresolveReviewThread*)
        printf '%s' '{"data":{"unresolveReviewThread":{"thread":{"id":"T1","isResolved":false}}}}'
        exit 0 ;;
      *resolveReviewThread*)
        printf '%s' '{"data":{"resolveReviewThread":{"thread":{"id":"T1","isResolved":true}}}}'
        exit 0 ;;
    esac
    cat "$state/comments.json"; exit 0 ;;
  run)
    printf '%s\n' \
      'test	UNKNOWN STEP	2026-01-01T00:00:00.0000000Z ##[group]Run pnpm test' \
      'test	UNKNOWN STEP	2026-01-01T00:00:01.0000000Z boom: expected true to be false' \
      'test	UNKNOWN STEP	2026-01-01T00:00:02.0000000Z ##[error]Process completed with exit code 1.'
    exit 0 ;;
esac
echo "unexpected gh $*" >&2
exit 2
`;

test("creates a draft pull request from the Changes panel and opens it", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  test.skip(process.platform === "win32", "The stand-in GitHub CLI is a POSIX shell script.");
  const { root, repo } = await createGitFixture();
  const origin = join(root, "origin.git");
  await git(root, ["init", "--bare", origin]);
  await git(repo, ["remote", "add", "origin", origin]);
  await git(repo, ["push", "-u", "origin", "main"]);
  const binDir = join(root, "bin");
  const ghState = join(root, "gh-state");
  await mkdir(binDir, { recursive: true });
  await mkdir(ghState, { recursive: true });
  await writeFile(join(binDir, "gh"), FAKE_GH, "utf8");
  await chmod(join(binDir, "gh"), 0o755);

  let fixture: DesktopFixture | undefined;
  try {
    fixture = await launchDesktop(repo, root, {
      env: { PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`, ZLI_FAKE_GH_STATE: ghState },
    });
    const page = fixture.page;
    await page.getByRole("button", { name: "Create worktree", exact: true }).click();
    const createWorktree = page.getByRole("dialog", { name: "Create worktree" });
    await createWorktree.getByLabel("Branch").fill("feature");
    await createWorktree.getByRole("button", { name: "Create worktree" }).click();
    const worktree = page.getByRole("button", { name: /feature/iu }).first();
    await expect(worktree).toContainText("Ready", { timeout: 30_000 });
    await worktree.click();
    const worktreePath = join(`${repo}-worktrees`, "feature");
    await writeFile(join(worktreePath, "greeting.txt"), "hello from the feature branch\n", "utf8");

    await page.getByRole("button", { name: "Changes", exact: true }).click();
    await page.getByRole("button", { name: "Refresh changes" }).click();
    const section = page.getByRole("group", { name: "Pull request" });
    await expect(section).toContainText("No pull request");

    await section.getByRole("button", { name: "Create PR" }).click();
    const dialog = page.getByRole("dialog", { name: "Create pull request" });
    await expect(dialog.getByRole("alert")).toContainText("1 file has uncommitted changes");
    await expect(dialog.getByRole("button", { name: "Create PR" })).toBeDisabled();
    await dialog.getByRole("button", { name: "Commit first" }).click();
    await expect(dialog).toHaveCount(0);
    const commitMessage = page.getByLabel("Commit message");
    await expect(commitMessage).toBeFocused();
    await commitMessage.fill("Add a greeting");
    await page.getByRole("button", { name: "Commit all changes" }).click();
    await expect.poll(() => git(worktreePath, ["log", "-1", "--format=%s"])).toBe("Add a greeting");

    await section.getByRole("button", { name: "Create PR" }).click();
    await expect(dialog.getByLabel("Title")).toHaveValue("Add a greeting");
    await expect(dialog.getByLabel("Description")).toHaveValue("- Add a greeting");
    await expect(dialog.getByRole("button", { name: "Base branch: main" })).toBeVisible();
    await expect(dialog.getByRole("checkbox", { name: /Create as draft/u })).toBeChecked();
    await dialog.getByRole("button", { name: "Create PR" }).click();
    await expect(dialog).toContainText("Opened as a draft", { timeout: 30_000 });
    await expect(dialog).toContainText(PR_URL);

    expect(await git(origin, ["rev-parse", "refs/heads/feature"])).toBe(await git(worktreePath, ["rev-parse", "HEAD"]));
    expect(await git(worktreePath, ["rev-parse", "--abbrev-ref", "feature@{upstream}"])).toBe("origin/feature");
    const calls = await readFile(join(ghState, "calls.log"), "utf8");
    expect(calls).toContain(
      "pr create --head feature --base main --title Add a greeting --body - Add a greeting --draft",
    );

    await dialog.getByRole("button", { name: "Open in browser" }).click();
    await expect.poll(() => page.evaluate(() => window.zli?.test?.takeExternalUrl?.())).toBe(PR_URL);
    await dialog.locator(".dialog-footer").getByRole("button", { name: "Close" }).click();
    await expect(dialog).toHaveCount(0);

    await expect(section).toContainText("#7");
    await expect(section).toContainText("Draft");
    await expect(section.getByRole("button", { name: "Create PR" })).toHaveCount(0);
    await section.getByRole("button", { name: "View PR" }).click();
    await expect.poll(() => page.evaluate(() => window.zli?.test?.takeExternalUrl?.())).toBe(PR_URL);
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});

test("shows a pull request's checks and sends a failed check's log to an agent", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  test.skip(process.platform === "win32", "The stand-in GitHub CLI is a POSIX shell script.");
  const { root, repo } = await createGitFixture();
  const origin = join(root, "origin.git");
  await git(root, ["init", "--bare", origin]);
  await git(repo, ["remote", "add", "origin", origin]);
  await git(repo, ["push", "-u", "origin", "main"]);
  const binDir = join(root, "bin");
  const ghState = join(root, "gh-state");
  await mkdir(binDir, { recursive: true });
  await mkdir(ghState, { recursive: true });
  await writeFile(join(binDir, "gh"), FAKE_GH, "utf8");
  await chmod(join(binDir, "gh"), 0o755);
  await writeFile(
    join(ghState, "pr.json"),
    JSON.stringify({
      url: PR_URL,
      state: "OPEN",
      isDraft: false,
      number: 7,
      reviewDecision: "CHANGES_REQUESTED",
      statusCheckRollup: [
        {
          __typename: "CheckRun",
          name: "test",
          workflowName: "CI",
          status: "COMPLETED",
          conclusion: "FAILURE",
          detailsUrl: "https://github.com/zli/fixture/actions/runs/5/job/9",
        },
        {
          __typename: "CheckRun",
          name: "build",
          workflowName: "CI",
          status: "COMPLETED",
          conclusion: "SUCCESS",
          detailsUrl: "https://github.com/zli/fixture/actions/runs/5/job/8",
        },
      ],
    }),
    "utf8",
  );

  let fixture: DesktopFixture | undefined;
  try {
    fixture = await launchDesktop(repo, root, {
      env: { PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`, ZLI_FAKE_GH_STATE: ghState },
    });
    const page = fixture.page;
    await page.getByRole("button", { name: "Create worktree", exact: true }).click();
    const createWorktree = page.getByRole("dialog", { name: "Create worktree" });
    await createWorktree.getByLabel("Branch").fill("checks");
    await createWorktree.getByRole("button", { name: "Create worktree" }).click();
    const worktree = page.getByRole("button", { name: /checks/iu }).first();
    await expect(worktree).toContainText("Ready", { timeout: 30_000 });
    await worktree.click();

    await page.locator(".sidebar-new-agent").click();
    const newAgent = page.getByRole("dialog", { name: "New agent" });
    await newAgent.getByText("Codex", { exact: true }).click();
    await newAgent.getByText("Chat", { exact: true }).click();
    await newAgent.getByRole("button", { name: "Start agent" }).click();
    await expect(page.getByRole("textbox", { name: "Message Codex" })).toBeEnabled({ timeout: 20_000 });

    await page.getByRole("button", { name: "Changes", exact: true }).click();
    await page.getByRole("button", { name: "Refresh changes" }).click();
    const section = page.getByRole("group", { name: "Pull request" });
    await expect(section).toContainText("#7", { timeout: 30_000 });
    await expect(section).toContainText("Changes requested");
    await expect(section).toContainText("1 check failed");
    await expect(section.getByRole("list", { name: "Checks" })).toContainText("build");

    await section.getByRole("button", { name: "Send to agent" }).click();
    const send = page.getByRole("dialog", { name: "Send failed check" });
    await expect(send.getByLabel("Message preview")).toContainText("boom: expected true to be false", {
      timeout: 30_000,
    });
    await expect(send.getByLabel("Message preview")).toContainText("pull request #7");
    await send.getByRole("button", { name: "Send", exact: true }).click();
    await expect(send).toHaveCount(0);
    await expect(page.getByText(/Mock response: The CI check/u)).toBeVisible({ timeout: 20_000 });

    // The sidebar shows the same pull request on the branch line under the agent.
    await expect(page.locator(".session-branch", { hasText: "checks" })).toContainText("#7", { timeout: 30_000 });
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});

test("reads a pull request's review comments and sends the picked ones to an agent", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  test.skip(process.platform === "win32", "The stand-in GitHub CLI is a POSIX shell script.");
  const { root, repo } = await createGitFixture();
  const origin = join(root, "origin.git");
  await git(root, ["init", "--bare", origin]);
  await git(repo, ["remote", "add", "origin", origin]);
  await git(repo, ["push", "-u", "origin", "main"]);
  const binDir = join(root, "bin");
  const ghState = join(root, "gh-state");
  await mkdir(binDir, { recursive: true });
  await mkdir(ghState, { recursive: true });
  await writeFile(join(binDir, "gh"), FAKE_GH, "utf8");
  await chmod(join(binDir, "gh"), 0o755);
  await writeFile(
    join(ghState, "pr.json"),
    JSON.stringify({ url: PR_URL, state: "OPEN", isDraft: false, number: 7, reviewDecision: "CHANGES_REQUESTED" }),
    "utf8",
  );
  await writeFile(
    join(ghState, "comments.json"),
    JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  id: "T1",
                  isResolved: false,
                  isOutdated: false,
                  path: "README.md",
                  line: 1,
                  comments: {
                    nodes: [
                      {
                        author: { login: "reviewer" },
                        body: "Make the title shorter.",
                        url: `${PR_URL}#discussion_r1`,
                        diffHunk: "@@ -0,0 +1 @@\n+# ZLI integration fixture",
                      },
                      { author: { login: "author" }, body: "Will do." },
                    ],
                  },
                },
                {
                  id: "T2",
                  isResolved: true,
                  path: "README.md",
                  line: 2,
                  comments: { nodes: [{ author: { login: "reviewer" }, body: "Already handled." }] },
                },
              ],
            },
            reviews: {
              nodes: [
                { id: "R1", author: { login: "reviewer" }, state: "CHANGES_REQUESTED", body: "Close, a few nits." },
              ],
            },
          },
        },
      },
    }),
    "utf8",
  );

  let fixture: DesktopFixture | undefined;
  try {
    fixture = await launchDesktop(repo, root, {
      env: { PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`, ZLI_FAKE_GH_STATE: ghState },
    });
    const page = fixture.page;
    await page.getByRole("button", { name: "Create worktree", exact: true }).click();
    const createWorktree = page.getByRole("dialog", { name: "Create worktree" });
    await createWorktree.getByLabel("Branch").fill("reviewed");
    await createWorktree.getByRole("button", { name: "Create worktree" }).click();
    const worktree = page.getByRole("button", { name: /reviewed/iu }).first();
    await expect(worktree).toContainText("Ready", { timeout: 30_000 });
    await worktree.click();

    await page.locator(".sidebar-new-agent").click();
    const newAgent = page.getByRole("dialog", { name: "New agent" });
    await newAgent.getByText("Codex", { exact: true }).click();
    await newAgent.getByText("Chat", { exact: true }).click();
    await newAgent.getByRole("button", { name: "Start agent" }).click();
    await expect(page.getByRole("textbox", { name: "Message Codex" })).toBeEnabled({ timeout: 20_000 });

    await page.getByRole("button", { name: "Changes", exact: true }).click();
    await page.getByRole("button", { name: "Refresh changes" }).click();
    const section = page.getByRole("group", { name: "Pull request" });
    await expect(section).toContainText("#7", { timeout: 30_000 });
    await section.getByRole("button", { name: "Review comments", exact: true }).click();
    const comments = section.getByRole("region", { name: "Pull request comments" });
    await expect(comments).toContainText("2 open review comments", { timeout: 30_000 });
    await expect(comments).toContainText("README.md:1");
    await expect(comments).toContainText("Make the title shorter.");
    await expect(comments).toContainText("1 more reply");
    await expect(comments).not.toContainText("Already handled.");
    const calls = await readFile(join(ghState, "calls.log"), "utf8");
    expect(calls).toMatch(/^api graphql -f query=.*-f owner=zli -f name=fixture -F number=7$/msu);

    await comments.getByRole("checkbox", { name: "Include Review by reviewer" }).uncheck();
    await comments.getByRole("button", { name: "Send 1 to agent" }).click();
    const send = page.getByRole("dialog", { name: "Send review comments" });
    const preview = send.getByLabel("Message preview");
    await expect(preview).toContainText("pull request #7");
    await expect(preview).toContainText("+# ZLI integration fixture");
    await expect(preview).toContainText("author: Will do.");
    await expect(preview).not.toContainText("Close, a few nits.");
    await send.getByRole("button", { name: "Send", exact: true }).click();
    await expect(send).toHaveCount(0);
    await expect(page.getByText(/Mock response: Please address this review comment from pull request #7/u)).toBeVisible(
      {
        timeout: 20_000,
      },
    );
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});

test("replies to and resolves a review thread, approves, and turns auto-merge on and off", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  test.skip(process.platform === "win32", "The stand-in GitHub CLI is a POSIX shell script.");
  const { root, repo } = await createGitFixture();
  const origin = join(root, "origin.git");
  await git(root, ["init", "--bare", origin]);
  await git(repo, ["remote", "add", "origin", origin]);
  await git(repo, ["push", "-u", "origin", "main"]);
  const binDir = join(root, "bin");
  const ghState = join(root, "gh-state");
  await mkdir(binDir, { recursive: true });
  await mkdir(ghState, { recursive: true });
  await writeFile(join(binDir, "gh"), FAKE_GH, "utf8");
  await chmod(join(binDir, "gh"), 0o755);
  await writeFile(
    join(ghState, "pr.json"),
    JSON.stringify({
      url: PR_URL,
      state: "OPEN",
      isDraft: false,
      number: 7,
      reviewDecision: "REVIEW_REQUIRED",
      autoMergeRequest: null,
      statusCheckRollup: [{ __typename: "CheckRun", name: "test", workflowName: "CI", status: "IN_PROGRESS" }],
    }),
    "utf8",
  );
  await writeFile(
    join(ghState, "comments.json"),
    JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  id: "T1",
                  isResolved: false,
                  isOutdated: false,
                  path: "README.md",
                  line: 1,
                  viewerCanReply: true,
                  viewerCanResolve: true,
                  viewerCanUnresolve: true,
                  comments: { nodes: [{ id: "C1", author: { login: "reviewer" }, body: "Make the title shorter." }] },
                },
              ],
            },
            reviews: { nodes: [] },
          },
        },
      },
    }),
    "utf8",
  );

  let fixture: DesktopFixture | undefined;
  try {
    fixture = await launchDesktop(repo, root, {
      env: { PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`, ZLI_FAKE_GH_STATE: ghState },
    });
    const page = fixture.page;
    await page.getByRole("button", { name: "Create worktree", exact: true }).click();
    const createWorktree = page.getByRole("dialog", { name: "Create worktree" });
    await createWorktree.getByLabel("Branch").fill("reviewing");
    await createWorktree.getByRole("button", { name: "Create worktree" }).click();
    const worktree = page.getByRole("button", { name: /reviewing/iu }).first();
    await expect(worktree).toContainText("Ready", { timeout: 30_000 });
    await worktree.click();

    await page.getByRole("button", { name: "Changes", exact: true }).click();
    await page.getByRole("button", { name: "Refresh changes" }).click();
    const section = page.getByRole("group", { name: "Pull request" });
    await expect(section).toContainText("#7", { timeout: 30_000 });
    const calls = () => readFile(join(ghState, "calls.log"), "utf8");

    await section.getByRole("button", { name: "Review comments" }).click();
    const comments = section.getByRole("region", { name: "Pull request comments" });
    await expect(comments).toContainText("1 open review comment", { timeout: 30_000 });
    await comments.getByRole("button", { name: "Reply on README.md:1" }).click();
    const reply = comments.getByRole("textbox", { name: "Reply on README.md:1" });
    await expect(reply).toBeFocused();
    await reply.fill("Thanks, fixed.");
    await reply.press("Control+Enter");
    await expect(comments).toContainText("1 more reply", { timeout: 30_000 });
    await expect(reply).toHaveCount(0);
    expect(await calls()).toContain("-f threadId=T1 -f body=Thanks, fixed.");

    await comments.getByRole("button", { name: "Resolve thread on README.md:1" }).click();
    await expect(comments).toContainText("Resolved", { timeout: 30_000 });
    await expect(comments).toContainText("No open review comments");
    await expect(comments.getByRole("button", { name: "Unresolve thread on README.md:1" })).toBeVisible();
    expect(await calls()).toMatch(/mutation\(\$threadId: ID!\) \{\s+resolveReviewThread/u);

    await section.getByRole("button", { name: "Review", exact: true }).click();
    const review = page.getByRole("dialog", { name: "Review pull request" });
    await review.getByRole("button", { name: "Approve" }).click();
    await review.getByRole("button", { name: "Submit review" }).click();
    await expect(review).toHaveCount(0, { timeout: 30_000 });
    await expect(section).toContainText("Approved", { timeout: 30_000 });
    expect(await calls()).toContain("pr review 7 --approve");

    await section.getByRole("button", { name: "Merge PR" }).click();
    const merge = page.getByRole("dialog", { name: "Merge pull request" });
    await merge.getByRole("button", { name: "Merge when ready" }).click();
    await expect(merge).toHaveCount(0, { timeout: 30_000 });
    await expect(section).toContainText("Auto-merge is on", { timeout: 30_000 });
    expect(await calls()).toContain("pr merge 7 --auto --squash");

    await section.getByRole("button", { name: "Turn off auto-merge" }).click();
    await expect(section).not.toContainText("Auto-merge is on", { timeout: 30_000 });
    expect(await calls()).toContain("pr merge 7 --disable-auto");
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});
