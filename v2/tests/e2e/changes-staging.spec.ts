import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import {
  closeDesktop,
  openCreateWorktree,
  createGitFixture,
  type DesktopFixture,
  git,
  launchDesktop,
} from "./desktop-fixtures.js";

test("stages a hunk, commits only it, and stashes the rest", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  const { root, repo } = await createGitFixture();
  let fixture: DesktopFixture | undefined;
  try {
    fixture = await launchDesktop(repo, root);
    const page = fixture.page;
    await openCreateWorktree(page);
    const createWorktree = page.getByRole("dialog", { name: "Create worktree" });
    await createWorktree.getByLabel("Branch").fill("staging");
    await createWorktree.getByRole("button", { name: "Create worktree" }).click();
    const worktree = page.getByRole("button", { name: /staging/iu }).first();
    await expect(worktree).toContainText("Ready", { timeout: 30_000 });
    await worktree.click();

    const worktreePath = join(`${repo}-worktrees`, "staging");
    await writeFile(join(worktreePath, "README.md"), "# ZLI integration fixture\n\nStaged on its own.\n", "utf8");
    await writeFile(join(worktreePath, "scratch.txt"), "not ready yet\n", "utf8");

    await page.getByRole("button", { name: "Changes", exact: true }).click();
    await page.getByRole("button", { name: "Refresh changes" }).click();
    const readme = page.getByRole("checkbox", { name: "Stage README.md" });
    await expect(readme).not.toBeChecked({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: "Commit all changes" })).toBeVisible();

    await page.locator(".review-file", { hasText: "README.md" }).click();
    const diff = page.getByRole("region", { name: "Diff for README.md" });
    await expect(diff.getByRole("button", { name: "Unstaged, 1 hunk" })).toHaveAttribute("aria-pressed", "true");
    await diff.getByRole("button", { name: "Stage hunk" }).click();
    await expect(readme).toBeChecked({ timeout: 20_000 });
    await expect(diff.getByRole("button", { name: "Staged, 1 hunk" })).toHaveAttribute("aria-pressed", "true");
    await expect(diff.getByRole("button", { name: "Unstage hunk" })).toBeVisible();

    await page.getByLabel("Commit message").fill("Stage the readme on its own");
    await page.getByRole("button", { name: "Commit 1 staged file" }).click();
    await expect.poll(() => git(worktreePath, ["log", "-1", "--format=%s"])).toBe("Stage the readme on its own");
    expect(await git(worktreePath, ["show", "--name-only", "--format=", "HEAD"])).toBe("README.md");
    expect(await git(worktreePath, ["status", "--porcelain=v1"])).toBe("?? scratch.txt");

    await page.getByRole("button", { name: "Refresh changes" }).click();
    await page.getByRole("button", { name: /^Stashes/u }).click();
    await page.getByLabel("Stash message").fill("park the scratch file");
    await page.getByRole("button", { name: "Stash changes" }).click();
    await expect(page.getByRole("button", { name: /^Stashes \(1\)/u })).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".review-stash-list")).toContainText("park the scratch file");
    await expect.poll(() => git(worktreePath, ["status", "--porcelain=v1"])).toBe("");

    await page.getByRole("button", { name: "Pop stash@{0}" }).click();
    await expect(page.getByRole("button", { name: /^Stashes \(0\)/u })).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => git(worktreePath, ["status", "--porcelain=v1"])).toBe("?? scratch.txt");
    await expect(page.getByRole("checkbox", { name: "Stage scratch.txt" })).toBeVisible({ timeout: 20_000 });

    await page.getByRole("button", { name: "Discard changes to scratch.txt" }).click();
    const confirm = page.getByRole("dialog", { name: "Delete file" });
    await expect(confirm).toContainText("This cannot be undone.");
    await confirm.getByRole("button", { name: "Delete file" }).click();
    await expect.poll(() => git(worktreePath, ["status", "--porcelain=v1"])).toBe("");
    await expect(page.getByText("Discarded the changes to scratch.txt.")).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Stage scratch.txt" })).toHaveCount(0, { timeout: 20_000 });
    // README.md stays listed as a commit on this branch, with nothing left to stage.
    await expect(page.locator(".review-file", { hasText: "README.md" })).toBeVisible();
    await expect(readme).toHaveCount(0);
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});
