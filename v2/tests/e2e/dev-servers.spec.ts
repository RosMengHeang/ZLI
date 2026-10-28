import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import {
  closeDesktop,
  openCreateWorktree,
  createGitFixture,
  type DesktopFixture,
  launchDesktop,
} from "./desktop-fixtures.js";

test("finds a dev server in terminal output and opens it in the browser panel", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  const { root, repo } = await createGitFixture();
  let fixture: DesktopFixture | undefined;
  try {
    fixture = await launchDesktop(repo, root);
    const page = fixture.page;
    await openCreateWorktree(page);
    const dialog = page.getByRole("dialog", { name: "Create worktree" });
    await dialog.getByLabel("Branch").fill("preview");
    await dialog.getByRole("button", { name: "Create worktree" }).click();
    const worktree = page.getByRole("button", { name: /preview/iu }).first();
    await expect(worktree).toContainText("Ready", { timeout: 30_000 });
    await worktree.click();

    const port = 44100 + Math.floor(Math.random() * 500);
    await writeFile(
      join(`${repo}-worktrees`, "preview", "serve.mjs"),
      [
        "import { createServer } from 'node:http';",
        "createServer((_request, response) => {",
        "  response.writeHead(200, { 'content-type': 'text/html' });",
        "  response.end('<!doctype html><title>Preview fixture</title><main>preview ready</main>');",
        `}).listen(${port}, '127.0.0.1', () => {`,
        // The same colored banner Vite prints, port in bold.
        `  console.log('\\n  \\u001b[32m➜\\u001b[39m  \\u001b[1mLocal\\u001b[22m:   \\u001b[36mhttp://localhost:\\u001b[1m${port}\\u001b[22m/\\u001b[39m');`,
        "});",
      ].join("\n"),
      "utf8",
    );

    const terminalToggle = page.getByRole("button", { name: "Terminal", exact: true });
    if ((await terminalToggle.getAttribute("aria-pressed")) !== "true") await terminalToggle.click();
    await page.getByRole("button", { name: "Start terminal" }).click();
    const output = page.getByRole("log", { name: "Terminal output" });
    // Keys typed before the shell prints its prompt are lost, which Windows PowerShell does slowly.
    await expect(output).toHaveText(/[$>#%]\s*$/u, { timeout: 20_000 });
    const input = page.locator(".terminal-output .xterm-helper-textarea");
    await input.focus();
    await page.keyboard.type("node serve.mjs");
    await page.keyboard.press("Enter");
    await expect(output).toContainText(`localhost:${port}`, {
      timeout: 20_000,
    });

    const chip = page.getByRole("button", { name: `Open localhost:${port} in the browser panel` });
    await expect(chip).toBeVisible({ timeout: 15_000 });
    await chip.click();
    await expect(page.getByRole("complementary", { name: "Browser panel" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Preview fixture" })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("textbox", { name: "Browser URL" })).toHaveValue(`http://localhost:${port}/`);

    await input.focus();
    await page.keyboard.press("Control+c");
    await expect(chip).toHaveCount(0, { timeout: 20_000 });
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});
