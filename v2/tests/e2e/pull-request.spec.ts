import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";

import { expect, test } from "@playwright/test";

import { closeDesktop, createGitFixture, git, launchDesktop, type DesktopFixture } from "./desktop-fixtures.js";

const PR_URL = "https://github.com/zli/fixture/pull/7";

// Stands in for the GitHub CLI: signed in, no pull request until `gh pr create` runs, and every call logged.
const FAKE_GH = `#!/bin/sh
state="$ZLI_FAKE_GH_STATE"
printf '%s\\n' "$*" >> "$state/calls.log"
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
    esac ;;
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
    await expect(section).toContainText("No pull request for this branch yet");

    await section.getByRole("button", { name: "Create PR" }).click();
    const dialog = page.getByRole("dialog", { name: "Create pull request" });
    await expect(dialog.getByRole("alert")).toContainText("1 file has uncommitted changes");
    await expect(dialog.getByRole("button", { name: "Create PR" })).toBeDisabled();
    await dialog.getByRole("button", { name: "Commit first" }).click();
    await expect(dialog).toHaveCount(0);
    const commitMessage = page.getByLabel("Commit message");
    await expect(commitMessage).toBeFocused();
    await commitMessage.fill("Add a greeting");
    await page.getByRole("button", { name: "Commit changes" }).click();
    await expect.poll(() => git(worktreePath, ["log", "-1", "--format=%s"])).toBe("Add a greeting");

    await section.getByRole("button", { name: "Create PR" }).click();
    await expect(dialog.getByLabel("Title")).toHaveValue("Add a greeting");
    await expect(dialog.getByLabel("Description")).toHaveValue("- Add a greeting");
    await expect(dialog.getByLabel("Base branch")).toHaveValue("main");
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
