import { execFile } from "node:child_process";
import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";

import {
  closeApp,
  closeDesktop,
  createGitFixture,
  type DesktopFixture,
  launchDesktop,
  openCreateWorktree,
  stopDesktopDaemon,
} from "./desktop-fixtures.js";

test("creates skills in Settings for every agent and for the project", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  const { root, repo } = await createGitFixture();
  let fixture: DesktopFixture | undefined;
  try {
    fixture = await launchDesktop(repo, root);
    const page = fixture.page;
    await expect(page.locator(".project-label")).toContainText("repo");
    await openCreateWorktree(page);
    const createWorktree = page.getByRole("dialog", { name: "Create worktree" });
    await createWorktree.getByLabel("Branch").fill("skills");
    await createWorktree.getByRole("button", { name: "Create worktree" }).click();
    await expect(page.getByRole("button", { name: /skills/iu }).first()).toContainText("Ready", { timeout: 30_000 });
    const worktreePath = join(`${repo}-worktrees`, "skills");

    await page.getByRole("button", { name: "Settings" }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings.getByRole("tab", { name: "Skills" }).click();
    await expect(settings).toContainText("No skills yet.");
    await expect(settings).toContainText("ZLI gives your enabled skills only to agents it starts.");

    await settings.getByRole("button", { name: "New skill" }).click();
    const form = settings.getByRole("form", { name: "New skill" });
    await form.getByLabel("Name").fill("code-review");
    await form.getByLabel("Description").fill("Review a diff for bugs before it merges.");
    await form.getByLabel("Instructions").fill("# Review\n\nRead the whole diff first.");
    await form.getByRole("button", { name: "Add skill" }).click();
    await expect(form).toHaveCount(0);
    const row = settings.locator(".mcp-row", { hasText: "code-review" });
    await expect(row).toContainText("Review a diff for bugs before it merges.");
    await expect(row).toContainText("User");
    await expect(settings.getByRole("switch", { name: "Give agents code-review" })).toBeChecked();

    expect(await readFile(join(root, "skills", "code-review", "SKILL.md"), "utf8")).toBe(
      "---\nname: code-review\ndescription: Review a diff for bugs before it merges.\n---\n\n# Review\n\nRead the whole diff first.\n",
    );
    // The copy for agents goes into the worktree, hidden from git.
    const copy = join(worktreePath, ".claude", "skills", "code-review", "SKILL.md");
    await expect.poll(() => readFile(copy, "utf8").catch(() => "")).toContain("name: code-review");
    expect(await gitStatus(worktreePath)).toBe("");

    await settings.getByRole("button", { name: "New skill" }).click();
    const projectForm = settings.getByRole("form", { name: "New skill" });
    await projectForm.getByRole("button", { name: /^Save to: /u }).click();
    await page.getByRole("option", { name: "repo, in .agents/skills" }).click();
    await projectForm.getByLabel("Name").fill("release-notes");
    await projectForm.getByLabel("Description").fill("Write release notes from merged changes.");
    await projectForm.getByRole("button", { name: "Add skill" }).click();
    await expect(projectForm).toHaveCount(0);
    await expect(settings.locator(".mcp-row", { hasText: "release-notes" })).toContainText("Project");
    expect(await readFile(join(repo, ".agents", "skills", "release-notes", "SKILL.md"), "utf8")).toContain(
      "name: release-notes",
    );

    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Settings" }).click();
    await settings.getByRole("tab", { name: "Skills" }).click();
    await expect(settings.locator(".mcp-row", { hasText: "code-review" })).toBeVisible();

    await settings.getByRole("button", { name: "Delete code-review" }).click();
    await settings.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(settings).toContainText("No skills yet.");

    const closing = fixture;
    fixture = undefined;
    await closeApp(closing);
    try {
      // Quitting takes ZLI's copies and its lines in .git/info/exclude away again.
      await expect(stat(join(worktreePath, ".claude"))).rejects.toThrow();
      expect(await readFile(join(repo, ".git", "info", "exclude"), "utf8")).not.toContain("zli:start");
    } finally {
      await stopDesktopDaemon(root);
      await rm(root, { recursive: true, force: true });
    }
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});

async function gitStatus(repo: string): Promise<string> {
  const { stdout } = await promisify(execFile)("git", ["status", "--porcelain"], { cwd: repo });
  return stdout;
}
