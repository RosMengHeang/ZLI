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

test("creates, switches, renames, and deletes branches from the Changes panel", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  const { root, repo } = await createGitFixture();
  const origin = join(root, "origin.git");
  await git(root, ["init", "--bare", origin]);
  await git(repo, ["remote", "add", "origin", origin]);
  await git(repo, ["push", "-u", "origin", "main"]);

  let fixture: DesktopFixture | undefined;
  try {
    fixture = await launchDesktop(repo, root);
    const page = fixture.page;
    await openCreateWorktree(page);
    const createWorktree = page.getByRole("dialog", { name: "Create worktree" });
    await createWorktree.getByLabel("Branch").fill("feature");
    await createWorktree.getByRole("button", { name: "Create worktree" }).click();
    const worktree = page.getByRole("button", { name: /feature/iu }).first();
    await expect(worktree).toContainText("Ready", { timeout: 30_000 });
    await worktree.click();
    const worktreePath = join(`${repo}-worktrees`, "feature");
    await writeFile(join(worktreePath, "one.txt"), "one\n", "utf8");
    await git(worktreePath, ["add", "one.txt"]);
    await git(worktreePath, ["commit", "-m", "One"]);
    await git(worktreePath, ["push", "-u", "origin", "feature"]);
    await writeFile(join(worktreePath, "two.txt"), "two\n", "utf8");
    await git(worktreePath, ["add", "two.txt"]);
    await git(worktreePath, ["commit", "-m", "Two"]);

    await page.getByRole("button", { name: "Changes", exact: true }).click();
    await expect(page.getByRole("button", { name: "Push, 1 to push" })).toBeVisible({ timeout: 30_000 });

    // A new branch, checked out at once; the sidebar follows the worktree onto it.
    await page.getByRole("button", { name: "Branch feature" }).click();
    const menu = page.getByRole("dialog", { name: "Branches" });
    await expect(menu.getByRole("option", { name: /feature/u }).first()).toContainText("↑1");
    await menu.getByRole("button", { name: "New branch" }).click();
    await menu.getByLabel("Name").fill("topic");
    await menu.getByRole("button", { name: "Create branch" }).click();
    await expect(menu).toHaveCount(0);
    await expect(page.getByText("Created topic and switched to it.")).toBeVisible();
    await expect.poll(() => git(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("topic");
    await expect(page.locator(".worktree-name", { hasText: "topic" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Branch topic" })).toBeVisible();

    // main is checked out in the project folder, so it can be neither checked out nor deleted here.
    await page.getByRole("button", { name: "Branch topic" }).click();
    await menu.getByLabel("Find a branch").fill("main");
    await expect(menu).toContainText("main is checked out in another worktree at");
    await expect(menu.getByRole("button", { name: "Switch" })).toBeDisabled();

    await menu.getByLabel("Find a branch").fill("feat");
    await menu.getByLabel("Find a branch").press("Enter");
    await expect(menu).toHaveCount(0);
    await expect.poll(() => git(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feature");
    await expect(page.locator(".worktree-name", { hasText: "feature" })).toBeVisible();

    await page.getByRole("button", { name: "Branch feature" }).click();
    await menu.getByLabel("Find a branch").fill("topic");
    await menu.getByRole("button", { name: "Rename" }).click();
    await menu.getByLabel("New name for topic").fill("topic-2");
    await menu.getByRole("button", { name: "Rename branch" }).click();
    await expect(menu).toHaveCount(0);
    expect(await git(worktreePath, ["branch", "--list", "topic*", "--format=%(refname:short)"])).toBe("topic-2");

    await page.getByRole("button", { name: "Branch feature" }).click();
    await menu.getByLabel("Find a branch").fill("topic-2");
    await menu.getByRole("button", { name: "Delete" }).click();
    await expect(menu).toContainText("Delete topic-2 on this computer?");
    await menu.getByRole("button", { name: "Delete branch" }).click();
    await expect(menu).toContainText("Deleted topic-2.");
    await expect(menu.getByRole("option", { name: /topic-2/u })).toHaveCount(0);
    expect(await git(worktreePath, ["branch", "--list", "topic*"])).toBe("");
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});
