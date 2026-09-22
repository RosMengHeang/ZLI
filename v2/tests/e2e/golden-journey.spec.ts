import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { closeDesktop, createGitFixture, git, launchDesktop, type DesktopFixture } from "./desktop-fixtures.js";

test("completes the workspace, provider, browser, review, and restoration journey", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  const { root, repo } = await createGitFixture();
  let fixture: DesktopFixture | undefined;
  try {
    fixture = await launchDesktop(repo, root);
    const page = fixture.page;
    await expect(page.locator(".project-label")).toContainText("repo");

    await page.getByRole("button", { name: "New" }).click();
    const dialog = page.getByRole("dialog", { name: "Create worktree" });
    await dialog.getByLabel("Branch").fill("e2e");
    await dialog.getByRole("button", { name: "Create worktree" }).click();
    const worktree = page.getByRole("button", { name: /e2e/iu });
    await expect(worktree).toContainText("Ready", { timeout: 30_000 });
    await worktree.click();

    const port = 43100 + Math.floor(Math.random() * 500);
    const worktreePath = join(repo + "-worktrees", "e2e");
    await writeFile(join(worktreePath, "dev-server.mjs"), [
      "import { createServer } from 'node:http';",
      "createServer((_request, response) => {",
      "  response.writeHead(200, { 'content-type': 'text/html' });",
      "  response.end('<!doctype html><title>ZLI fixture</title><main>browser fixture ready</main>');",
      `}).listen(${port}, '127.0.0.1', () => console.log('ZLI_DEV_READY ${port}'));`,
    ].join("\n"), "utf8");
    await page.getByRole("button", { name: "Terminal" }).click();
    await page.getByRole("button", { name: "Start terminal" }).click();
    await page.getByRole("textbox", { name: "Terminal command" }).fill("node dev-server.mjs");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByRole("log", { name: "Terminal output" })).toContainText(`ZLI_DEV_READY ${port}`, { timeout: 20_000 });

    await page.getByRole("button", { name: "Agent" }).click();
    await page.getByRole("button", { name: "Start Codex" }).click();
    const composer = page.getByRole("textbox", { name: "Message Codex" });
    await expect(composer).toBeVisible();
    await composer.fill("inspect workspace");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("Mock response: inspect workspace")).toBeVisible();

    await page.getByRole("button", { name: "Browser" }).click();
    await page.getByRole("textbox", { name: "Browser URL" }).fill(`http://127.0.0.1:${port}`);
    await page.getByRole("button", { name: "Open" }).click();
    await expect(page.getByRole("heading", { name: "ZLI fixture" })).toBeVisible({ timeout: 20_000 });

    const browserTabId = await page.evaluate(async () => {
      const projection = await window.zli?.runtime.getProjection();
      return projection?.browserTabs.at(-1)?.browserTabId;
    });
    if (!browserTabId) throw new Error("The browser tab was not projected to the renderer.");
    const snapshot = await page.evaluate(async (tabId) => window.zli!.browser.snapshot(tabId), browserTabId);
    expect(JSON.stringify(snapshot)).toContain("browser fixture ready");
    const designInspection = await page.evaluate(async (tabId) => window.zli!.browser.designInspect({ browserTabId: tabId, selector: "main" }), browserTabId);
    expect(designInspection).toMatchObject({ tag: "main", text: "browser fixture ready", screenshot: { mimeType: "image/png" } });

    const terminalId = await page.evaluate(async () => {
      const projection = await window.zli?.runtime.getProjection();
      return projection?.terminals.at(-1)?.terminalId;
    });
    if (!terminalId) throw new Error("The PTY terminal was not projected to the renderer.");
    await page.evaluate(async (id) => window.zli!.runtime.dispatch({
      protocolVersion: 1,
      commandId: crypto.randomUUID(),
      command: { type: "terminal.write", terminalId: id, data: "\u0003" },
    }), terminalId);

    await writeFile(join(worktreePath, "change.txt"), "integration change\n", "utf8");
    await page.getByRole("button", { name: "Review" }).click();
    await page.getByRole("button", { name: "Refresh changes" }).click();
    await expect(page.getByText("change.txt")).toBeVisible({ timeout: 20_000 });
    await page.getByLabel("Commit message").fill("exercise review flow");
    await page.getByRole("button", { name: "Commit changes" }).click();
    await expect.poll(() => git(worktreePath, ["status", "--porcelain"])).toBe("");
    await page.getByRole("button", { name: "Merge into target" }).click();
    await expect.poll(() => git(repo, ["show", "main:change.txt"])).toBe("integration change");

    await fixture.app.close();
    fixture = await launchDesktop(repo, root);
    await expect(fixture.page.getByRole("button", { name: /e2e/iu })).toContainText("Ready");
    await fixture.page.getByRole("button", { name: "Agent" }).click();
    await expect(fixture.page.getByText("Mock response: inspect workspace")).toBeVisible();
    await fixture.page.getByRole("button", { name: "Browser" }).click();
    await expect(fixture.page.getByRole("heading", { name: "ZLI fixture" })).toBeVisible({ timeout: 20_000 });
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});
