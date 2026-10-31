import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";

import { expect, test } from "@playwright/test";

import { closeDesktop, createGitFixture, type DesktopFixture, git, launchDesktop } from "./desktop-fixtures.js";

const ISSUE = {
  number: 42,
  title: "Login button does nothing",
  state: "OPEN",
  url: "https://github.com/zli/fixture/issues/42",
  updatedAt: "2026-01-02T03:04:05Z",
  author: { login: "octo" },
  assignees: [{ login: "alice" }],
  labels: [{ name: "bug", color: "d73a4a" }],
  comments: [{ author: { login: "bob" }, body: "Seen on Safari too.", createdAt: "2026-01-03T00:00:00Z" }],
  body: "Clicking Log in does nothing.",
};
const OTHER = { ...ISSUE, number: 7, title: "Dark mode colors", labels: [], comments: [], body: "Too bright." };

// Stands in for the GitHub CLI: signed in, two issues, no pull request, and every call logged.
const FAKE_GH = `#!/bin/sh
state="$ZLI_FAKE_GH_STATE"
printf '%s\\n' "$*" >> "$state/calls.log"
case "$1" in
  --version) echo "gh version 2.0.0 (fake)"; exit 0 ;;
  auth) exit 0 ;;
  issue)
    case "$2" in
      list) cat "$state/issues.json"; exit 0 ;;
      view)
        if [ -f "$state/issue-$3.json" ]; then cat "$state/issue-$3.json"; exit 0; fi
        echo "GraphQL: Could not resolve to an issue or pull request with the number of $3." >&2
        exit 1 ;;
    esac ;;
  pr)
    echo "no pull requests found for branch \\"$3\\"" >&2
    exit 1 ;;
esac
echo "unexpected gh $*" >&2
exit 2
`;

const GITLAB_ISSUE = {
  id: 9001,
  iid: 12,
  title: "Sign in button does nothing",
  description: "The sign in button does nothing.",
  state: "opened",
  updated_at: "2026-01-02T03:04:05.000Z",
  labels: ["bug", "frontend"],
  assignees: [{ username: "alice" }],
  author: { username: "octo" },
  user_notes_count: 1,
  web_url: "https://gitlab.company.com/acme/app/-/issues/12",
};
const GITLAB_NOTES = [
  { body: "added ~bug label", author: { username: "octo" }, created_at: "2026-01-02T00:00:00Z", system: true },
  { body: "Seen on Firefox too.", author: { username: "bob" }, created_at: "2026-01-03T00:00:00Z", system: false },
];

// Stands in for the GitLab CLI: signed in to gitlab.company.com, one issue, and every call logged.
const FAKE_GLAB = `#!/bin/sh
state="$ZLI_FAKE_GLAB_STATE"
printf '%s\\n' "$*" >> "$state/calls.log"
case "$1" in
  --version) echo "glab 1.50.0 (fake)"; exit 0 ;;
  auth) [ "$3" = "--hostname" ] && [ "$4" = "gitlab.company.com" ] && exit 0
    echo "not signed in to $4" >&2; exit 1 ;;
  issue)
    case "$2" in
      list) cat "$state/issues.json"; exit 0 ;;
      view)
        if [ -f "$state/issue-$3.json" ]; then cat "$state/issue-$3.json"; exit 0; fi
        echo "ERROR: 404 Not Found" >&2
        exit 1 ;;
    esac ;;
esac
echo "unexpected glab $*" >&2
exit 2
`;

test("lists GitHub issues and starts an agent from one", async () => {
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
  await writeFile(join(ghState, "issues.json"), JSON.stringify([ISSUE, OTHER]), "utf8");
  await writeFile(join(ghState, "issue-42.json"), JSON.stringify(ISSUE), "utf8");
  await writeFile(join(ghState, "issue-7.json"), JSON.stringify(OTHER), "utf8");

  let fixture: DesktopFixture | undefined;
  try {
    fixture = await launchDesktop(repo, root, {
      env: { PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`, ZLI_FAKE_GH_STATE: ghState },
    });
    const page = fixture.page;
    await expect(page.locator(".project-label")).toContainText("repo");

    await page.getByRole("button", { name: "Issues", exact: true }).click();
    const issues = page.getByRole("dialog", { name: "Issues" });
    const list = issues.getByRole("list", { name: "GitHub issues" });
    await expect(list.getByRole("button")).toHaveCount(2, { timeout: 30_000 });
    await expect(list).toContainText("#42");
    await expect(list).toContainText("Login button does nothing");
    await expect(list).toContainText("bug");

    await issues.getByRole("button", { name: "Assigned to me" }).click();
    await expect.poll(() => readFile(join(ghState, "calls.log"), "utf8")).toContain("--assignee @me");

    await list.getByRole("button", { name: /Dark mode colors/u }).click();
    const details = issues.getByRole("region", { name: "Issue details" });
    await expect(details).toContainText("Too bright.");
    await list.getByRole("button", { name: /Login button does nothing/u }).click();
    await expect(details).toContainText("Clicking Log in does nothing.");
    await expect(details).toContainText("Seen on Safari too.");
    await issues.getByRole("button", { name: "Start agent" }).click();
    await expect(issues).toHaveCount(0);

    const newAgent = page.getByRole("dialog", { name: "New agent" });
    await expect(newAgent.getByLabel("Branch name")).toHaveValue("issue-42-login-button-does-nothing");
    const firstMessage = newAgent.getByLabel("First message");
    await expect(firstMessage).toHaveValue(/^Work on GitHub issue #42: Login button does nothing\n/u);
    await expect(firstMessage).toHaveValue(/https:\/\/github\.com\/zli\/fixture\/issues\/42/u);
    await expect(firstMessage).toHaveValue(/Seen on Safari too\./u);
    await expect(firstMessage).toHaveValue(/When you finish, mention Fixes #42 in the PR\.$/u);
    await newAgent.getByText("Codex", { exact: true }).click();
    await newAgent.getByText("Chat", { exact: true }).click();
    await newAgent.getByRole("button", { name: "Start agent" }).click();
    await expect(newAgent).toHaveCount(0);

    await expect(page.getByText(/Mock response: Work on GitHub issue #42/u).first()).toBeVisible({ timeout: 30_000 });
    const worktreePath = join(`${repo}-worktrees`, "issue-42-login-button-does-nothing");
    expect(await git(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("issue-42-login-button-does-nothing");

    // The pull request from this worktree closes the issue.
    await writeFile(join(worktreePath, "fix.txt"), "fixed\n", "utf8");
    await git(worktreePath, ["add", "fix.txt"]);
    await git(worktreePath, ["commit", "-m", "Fix the login button"]);
    await page.getByRole("button", { name: "Changes", exact: true }).click();
    await page.getByRole("button", { name: "Refresh changes" }).click();
    const section = page.getByRole("group", { name: "Pull request" });
    await section.getByRole("button", { name: "Create PR" }).click({ timeout: 30_000 });
    const dialog = page.getByRole("dialog", { name: "Create pull request" });
    await expect(dialog.getByLabel("Description")).toHaveValue("- Fix the login button\n\nFixes #42", {
      timeout: 30_000,
    });
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});

test("lists GitLab issues with glab and starts an agent from one", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  test.skip(process.platform === "win32", "The stand-in GitLab CLI is a POSIX shell script.");
  const { root, repo } = await createGitFixture();
  await git(repo, ["remote", "add", "origin", "git@gitlab.company.com:acme/app.git"]);
  const binDir = join(root, "bin");
  const glabState = join(root, "glab-state");
  await mkdir(binDir, { recursive: true });
  await mkdir(glabState, { recursive: true });
  await writeFile(join(binDir, "glab"), FAKE_GLAB, "utf8");
  await chmod(join(binDir, "glab"), 0o755);
  await writeFile(join(glabState, "issues.json"), JSON.stringify([GITLAB_ISSUE]), "utf8");
  await writeFile(join(glabState, "issue-12.json"), JSON.stringify({ ...GITLAB_ISSUE, Notes: GITLAB_NOTES }), "utf8");

  let fixture: DesktopFixture | undefined;
  try {
    fixture = await launchDesktop(repo, root, {
      env: {
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        ZLI_FAKE_GLAB_STATE: glabState,
        GLAB_CONFIG_DIR: join(root, "glab-config"),
      },
    });
    const page = fixture.page;
    await expect(page.locator(".project-label")).toContainText("repo");

    await page.getByRole("button", { name: "Issues", exact: true }).click();
    const issues = page.getByRole("dialog", { name: "Issues" });
    const list = issues.getByRole("list", { name: "GitLab issues" });
    await expect(list.getByRole("button")).toHaveCount(1, { timeout: 30_000 });
    await expect(list).toContainText("#12");
    await expect(list).toContainText("frontend");
    await issues.getByRole("button", { name: "Assigned to me" }).click();
    await expect.poll(() => readFile(join(glabState, "calls.log"), "utf8")).toContain("--assignee=@me");
    await expect
      .poll(() => readFile(join(glabState, "calls.log"), "utf8"))
      .toContain("auth status --hostname gitlab.company.com");

    const details = issues.getByRole("region", { name: "Issue details" });
    await expect(details).toContainText("The sign in button does nothing.");
    await expect(details).toContainText("Seen on Firefox too.");
    await expect(details).not.toContainText("added ~bug label");
    await issues.getByRole("button", { name: "Start agent" }).click();
    await expect(issues).toHaveCount(0);

    const newAgent = page.getByRole("dialog", { name: "New agent" });
    await expect(newAgent.getByLabel("Branch name")).toHaveValue("issue-12-sign-in-button-does-nothing");
    const firstMessage = newAgent.getByLabel("First message");
    await expect(firstMessage).toHaveValue(/^Work on GitLab issue #12: Sign in button does nothing\n/u);
    await expect(firstMessage).toHaveValue(/https:\/\/gitlab\.company\.com\/acme\/app\/-\/issues\/12/u);
    await expect(firstMessage).toHaveValue(/When you finish, mention Fixes #12 in the merge request\.$/u);
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});

test("explains how to read a GitLab project's issues without glab", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  test.skip(process.platform === "win32", "Hiding glab relies on POSIX PATH lookup.");
  const { root, repo } = await createGitFixture();
  await git(repo, ["remote", "add", "origin", "https://gitlab.com/acme/app.git"]);
  const pathWithoutGlab = (process.env.PATH ?? "")
    .split(delimiter)
    .filter((dir) => dir !== "" && !existsSync(join(dir, "glab")))
    .join(delimiter);

  let fixture: DesktopFixture | undefined;
  try {
    fixture = await launchDesktop(repo, root, { env: { PATH: pathWithoutGlab } });
    const page = fixture.page;
    await expect(page.locator(".project-label")).toContainText("repo");

    await page.getByRole("button", { name: "Issues", exact: true }).click();
    const issues = page.getByRole("dialog", { name: "Issues" });
    await expect(issues.getByRole("alert")).toContainText("GitLab CLI (glab) is not installed", { timeout: 30_000 });
    await expect(issues.getByRole("button", { name: "Try again" })).toBeVisible();
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});

test("explains a project hosted outside GitHub and GitLab and starts an agent without an issue", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  const { root, repo } = await createGitFixture();
  await git(repo, ["remote", "add", "origin", "git@bitbucket.org:acme/app.git"]);
  const configDir = join(root, "cli-config");
  await mkdir(configDir, { recursive: true });

  let fixture: DesktopFixture | undefined;
  try {
    fixture = await launchDesktop(repo, root, { env: { GH_CONFIG_DIR: configDir, GLAB_CONFIG_DIR: configDir } });
    const page = fixture.page;
    await expect(page.locator(".project-label")).toContainText("repo");

    await page.getByRole("button", { name: "Issues", exact: true }).click();
    const issues = page.getByRole("dialog", { name: "Issues" });
    await expect(issues.getByText("This project's remote is on bitbucket.org.")).toBeVisible({ timeout: 30_000 });
    await expect(issues.getByText("ZLI can read issues from GitHub, GitLab, and Linear today.")).toBeVisible();
    await expect(issues.getByRole("alert")).toHaveCount(0);
    await expect(issues.getByRole("button", { name: "Try again" })).toHaveCount(0);
    await expect(issues.getByRole("button", { name: "Connect Linear" })).toHaveCount(2);

    await issues.getByRole("button", { name: "Start without an issue" }).click();
    await expect(issues).toHaveCount(0);
    const newAgent = page.getByRole("dialog", { name: "New agent" });
    await expect(newAgent).toBeVisible();
    await expect(newAgent.getByLabel("First message")).toHaveCount(0);
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});
