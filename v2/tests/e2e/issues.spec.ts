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

test("explains a project hosted outside GitHub and starts an agent without an issue", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  const { root, repo } = await createGitFixture();
  await git(repo, ["remote", "add", "origin", "git@gitlab.company.com:acme/app.git"]);
  const ghConfig = join(root, "gh-config");
  await mkdir(ghConfig, { recursive: true });

  let fixture: DesktopFixture | undefined;
  try {
    fixture = await launchDesktop(repo, root, { env: { GH_CONFIG_DIR: ghConfig } });
    const page = fixture.page;
    await expect(page.locator(".project-label")).toContainText("repo");

    await page.getByRole("button", { name: "Issues", exact: true }).click();
    const issues = page.getByRole("dialog", { name: "Issues" });
    await expect(issues.getByText("This project's remote is on gitlab.company.com.")).toBeVisible({ timeout: 30_000 });
    await expect(issues.getByText("ZLI can read issues from GitHub and Linear today.")).toBeVisible();
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
