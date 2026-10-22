import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { closeDesktop, createGitFixture, launchDesktop, type DesktopFixture } from "./desktop-fixtures.js";

test("browses, edits, finds, and searches files in a worktree", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  const { root, repo } = await createGitFixture();
  let fixture: DesktopFixture | undefined;
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  try {
    fixture = await launchDesktop(repo, root);
    const page = fixture.page;
    await page.getByRole("button", { name: "Create worktree", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Create worktree" });
    await dialog.getByLabel("Branch").fill("files");
    await dialog.getByRole("button", { name: "Create worktree" }).click();
    const worktree = page.getByRole("button", { name: /files/iu }).first();
    await expect(worktree).toContainText("Ready", { timeout: 30_000 });
    await worktree.click();
    const worktreePath = join(`${repo}-worktrees`, "files");
    await mkdir(join(worktreePath, "src"), { recursive: true });
    await writeFile(join(worktreePath, "src", "app.ts"), "export const greeting = 'hello fixture';\n", "utf8");

    await page.getByRole("button", { name: "Files", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "Files panel" });
    const folder = panel.getByRole("button", { name: /^src 1 changed$/u });
    await expect(folder).toBeVisible({ timeout: 10_000 });
    await expect(folder.locator(".file-row-changed")).toHaveCount(1);
    await folder.click();
    await expect(panel.locator(".file-row", { hasText: "app.ts" }).locator(".file-status-untracked")).toHaveText("U");

    await panel.locator(".file-row", { hasText: "README.md" }).click();
    const editor = panel.locator(".cm-content");
    await expect(editor).toContainText("ZLI integration fixture");
    await editor.click();
    await page.keyboard.press(`${mod}+End`);
    await page.keyboard.type("Edited in ZLI\n");
    await expect(panel.locator(".file-tab-dirty")).toHaveCount(1);
    await page.keyboard.press(`${mod}+s`);
    await expect(panel.locator(".file-tab-dirty")).toHaveCount(0);
    await expect
      .poll(async () => (await readFile(join(worktreePath, "README.md"), "utf8")).replaceAll("\r\n", "\n"))
      .toBe("# ZLI integration fixture\nEdited in ZLI\n");
    // A narrow panel hides the file list while a file is open, so read the status from the open file's path bar.
    await expect(panel.locator(".file-path-bar .file-status-modified")).toHaveText("M", { timeout: 10_000 });

    await writeFile(join(worktreePath, "README.md"), "# Changed by an agent\n", "utf8");
    await expect(editor).toContainText("Changed by an agent", { timeout: 10_000 });

    await page.keyboard.press(`${mod}+p`);
    const quickOpen = page.getByRole("dialog", { name: "Go to file" });
    await quickOpen.getByRole("textbox", { name: "File name" }).fill("app:1");
    await quickOpen.getByRole("textbox", { name: "File name" }).press("Enter");
    await expect(quickOpen).toHaveCount(0);
    await expect(editor).toContainText("hello fixture");
    await expect(panel.getByRole("tab", { name: "app.ts" })).toHaveAttribute("aria-selected", "true");

    await page.keyboard.press(`${mod}+Shift+f`);
    const search = panel.getByRole("textbox", { name: "Search in files" });
    await expect(search).toBeFocused();
    await search.fill("agent");
    const match = panel.locator(".search-match").first();
    await expect(match).toContainText("Changed by an agent", { timeout: 10_000 });
    await match.click();
    await expect(panel.getByRole("tab", { name: "README.md" })).toHaveAttribute("aria-selected", "true");
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});
