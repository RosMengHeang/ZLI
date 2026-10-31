import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { expect, type Page, test } from "@playwright/test";

import {
  captureProcessTree,
  closeApp,
  closeDesktop,
  createGitFixture,
  type DesktopFixture,
  desktopCommand,
  launchDesktop,
  openCreateWorktree,
  stopDesktopDaemon,
} from "./desktop-fixtures.js";

test("a second launch on the same data quits and leaves the first one running", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  test.setTimeout(120_000);
  const { root, repo } = await createGitFixture();
  let fixture: DesktopFixture | undefined;
  let secondRan = false;
  try {
    fixture = await launchDesktop(repo, root);
    const { app, page } = fixture;
    await openCreateWorktree(page);
    const dialog = page.getByRole("dialog", { name: "Create worktree" });
    await dialog.getByLabel("Branch").fill("second");
    await dialog.getByRole("button", { name: "Create worktree" }).click();
    const worktree = page.getByRole("button", { name: /second/iu }).first();
    await expect(worktree).toContainText("Ready", { timeout: 30_000 });
    await worktree.click();
    const terminalToggle = page.getByRole("button", { name: "Terminal", exact: true });
    if ((await terminalToggle.getAttribute("aria-pressed")) !== "true") await terminalToggle.click();
    await page.getByRole("button", { name: "Start terminal" }).click();
    const output = page.getByRole("log", { name: "Terminal output" });
    // Keys typed before the shell prints its prompt are lost.
    await expect(output).toHaveText(/[$>#%]\s*$/u, { timeout: 20_000 });
    await runInTerminal(page, "echo before-$((40+2))");
    await expect(output).toContainText("before-42", { timeout: 20_000 });

    const daemon = JSON.parse(await readFile(join(root, "runtime.sqlite.daemon.json"), "utf8")) as { pid: number };
    const controlFile = join(root, "runtime.sqlite.browser-control.json");
    const control = await readFile(controlFile, "utf8");
    // Minimizing does nothing on a display with no window manager, as on Linux CI, but hiding does.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.hide());
    await expect
      .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible()))
      .toBe(false);

    const command = await desktopCommand(repo, root);
    const second = spawn(command.executablePath ?? app.process().spawnfile, command.args, {
      env: command.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    second.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    let exitCode: number | null;
    try {
      exitCode = await new Promise<number | null>((resolveExit, reject) => {
        const timer = setTimeout(() => reject(new Error("The second launch kept running.")), 20_000);
        second.once("error", reject);
        second.once("exit", (code) => {
          clearTimeout(timer);
          resolveExit(code);
        });
      });
    } finally {
      if (second.exitCode === null && second.signalCode === null) {
        secondRan = true;
        for (const pid of await captureProcessTree(second.pid)) signal(pid, "SIGKILL");
      }
    }
    expect(exitCode, stderr).toBe(0);

    expect(isRunning(daemon.pid)).toBe(true);
    expect(await readFile(controlFile, "utf8")).toBe(control);
    await expect
      .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible()))
      .toBe(true);
    await runInTerminal(page, "echo after-$((40+2))");
    await expect(output).toContainText("after-42", { timeout: 20_000 });
  } finally {
    if (fixture && secondRan) {
      // After a second copy has started in full, the first one's page stops answering, and asking it to
      // stop its terminals would hang until the test times out.
      await closeApp(fixture, { stopTerminals: false });
      await stopDesktopDaemon(root);
      await rm(root, { recursive: true, force: true });
    } else if (fixture) await closeDesktop(fixture);
    else await rm(root, { recursive: true, force: true });
  }
});

async function runInTerminal(page: Page, line: string): Promise<void> {
  await page.locator(".terminal-output .xterm-helper-textarea").focus();
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
