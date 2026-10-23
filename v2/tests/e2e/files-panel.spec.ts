import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { closeDesktop, createGitFixture, type DesktopFixture, launchDesktop } from "./desktop-fixtures.js";

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

    // Views picked in earlier runs are remembered, and this test starts from the default one.
    await page.evaluate(() => window.localStorage.removeItem("zli.files.viewModes.v1"));
    await page.getByRole("button", { name: "Files", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "Files panel" });
    const folder = panel.getByRole("button", { name: /^src 1 changed$/u });
    await expect(folder).toBeVisible({ timeout: 10_000 });
    await expect(folder.locator(".file-row-changed")).toHaveCount(1);
    await folder.click();
    // Changed files are listed twice: in the Changed group at the top and in place in the tree.
    const changed = panel.locator('.file-row[data-group="changed"]');
    await expect(changed).toHaveCount(1);
    await expect(changed.locator(".file-status-untracked")).toHaveText("U");
    await expect(
      panel.locator(".file-row:not([data-group])", { hasText: "app.ts" }).locator(".file-status-untracked"),
    ).toHaveText("U");

    await panel.locator(".file-row", { hasText: "README.md" }).click();
    // Markdown opens rendered; the Code tab shows the editor.
    await expect(panel.getByRole("region", { name: "Preview of README.md" }).locator("h1")).toHaveText(
      "ZLI integration fixture",
    );
    await panel.getByRole("tab", { name: "Code", exact: true }).click();
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
    const diff = panel.getByRole("button", { name: "Diff", exact: true });
    await diff.click();
    await expect(diff).toHaveAttribute("aria-pressed", "true");
    await expect(panel.locator(".file-diff")).toContainText("Edited in ZLI", { timeout: 10_000 });
    await diff.click();

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

test("adds selected lines to the agent chat and sends them with the next message", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  const { root, repo } = await createGitFixture();
  let fixture: DesktopFixture | undefined;
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  try {
    fixture = await launchDesktop(repo, root);
    const page = fixture.page;
    await page.locator(".sidebar-new-agent").click();
    const newAgent = page.getByRole("dialog", { name: "New agent" });
    await newAgent.getByText("Codex", { exact: true }).click();
    await newAgent.getByText("Chat", { exact: true }).click();
    await newAgent.getByLabel("First message").fill("Look at the code");
    await newAgent.getByRole("button", { name: "Start agent" }).click();
    await expect(page.getByText(/Mock response: Look at the code/u)).toBeVisible({ timeout: 30_000 });

    const worktreePath = await page.evaluate(async () => {
      const projection = await window.zli?.runtime.getProjection();
      const thread = projection?.threads[0];
      return projection?.worktrees.find((worktree) => worktree.worktreeId === thread?.worktreeId)?.path ?? "";
    });
    expect(worktreePath).not.toBe("");
    await mkdir(join(worktreePath, "src"), { recursive: true });
    await writeFile(
      join(worktreePath, "src", "math.ts"),
      "export const one = 1;\nexport const two = 2;\nexport const three = 3;\n",
      "utf8",
    );

    await page.getByRole("button", { name: "Files", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "Files panel" });
    await panel.locator('.file-row[data-group="changed"]', { hasText: "math.ts" }).click({ timeout: 10_000 });
    const editor = panel.locator(".cm-content");
    await expect(editor).toContainText("export const two");
    await editor.locator(".cm-line").nth(1).click();
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+ArrowDown");
    await page.keyboard.press("Shift+End");
    await page.keyboard.press(`${mod}+l`);

    const attachments = page.getByRole("list", { name: "Attachments" });
    await expect(attachments).toContainText("math.ts:2-3");
    const composer = page.getByRole("textbox", { name: "Message Codex" });
    await expect(composer).toBeFocused();
    await composer.fill("What are these?");
    await composer.press("Enter");
    await expect(page.getByText(/Mock response: .*src\/math\.ts/u).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".md-code").last()).toContainText("export const three = 3;");
    await expect(attachments).toHaveCount(0);
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});
