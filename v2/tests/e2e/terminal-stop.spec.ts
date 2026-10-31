import { expect, type Page, test } from "@playwright/test";

import {
  closeDesktop,
  createGitFixture,
  type DesktopFixture,
  launchDesktop,
  openCreateWorktree,
} from "./desktop-fixtures.js";

const pids: number[] = [];

test.afterEach(() => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
});

test("stopping a drawer terminal ends its shell and the jobs it started", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  test.skip(process.platform === "win32", "This checks POSIX shell process groups.");
  test.setTimeout(120_000);
  const { root, repo } = await createGitFixture();
  let fixture: DesktopFixture | undefined;
  try {
    fixture = await launchDesktop(repo, root);
    const { page } = fixture;
    const shell = await startDrawerShell(page, "stop");

    await page.getByRole("button", { name: "Stop Terminal 1" }).click();
    await expect(page.getByText("No shell in")).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => [shell.shellPid, shell.jobPid].filter(isRunning), { timeout: 10_000 }).toEqual([]);
    await expect
      .poll(async () =>
        page.evaluate(
          async (id) =>
            (await window.zli?.runtime.getProjection())?.terminals.find((terminal) => terminal.terminalId === id)
              ?.status,
          shell.terminalId,
        ),
      )
      .toBe("exited");
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});

test("removing a project with a shell open ends the shell without waiting out a timeout", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  test.skip(process.platform === "win32", "This checks POSIX shell process groups.");
  test.setTimeout(120_000);
  const { root, repo } = await createGitFixture();
  let fixture: DesktopFixture | undefined;
  try {
    fixture = await launchDesktop(repo, root);
    const { page } = fixture;
    const shell = await startDrawerShell(page, "remove");

    await page.getByRole("button", { name: "Settings" }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings.getByRole("tab", { name: "Projects" }).click();
    await settings.getByRole("button", { name: "Remove repo" }).click();
    const started = Date.now();
    await settings.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(settings).toContainText("Removed repo from ZLI.", { timeout: 15_000 });
    // The app gives running shells 8 seconds to exit before it removes the project anyway.
    expect(Date.now() - started).toBeLessThan(6_000);
    await expect.poll(() => [shell.shellPid, shell.jobPid].filter(isRunning), { timeout: 10_000 }).toEqual([]);
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});

async function startDrawerShell(page: Page, branch: string) {
  await openCreateWorktree(page);
  const dialog = page.getByRole("dialog", { name: "Create worktree" });
  await dialog.getByLabel("Branch").fill(branch);
  await dialog.getByRole("button", { name: "Create worktree" }).click();
  const worktree = page.getByRole("button", { name: new RegExp(branch, "iu") }).first();
  await expect(worktree).toContainText("Ready", { timeout: 30_000 });
  await worktree.click();

  const terminalToggle = page.getByRole("button", { name: "Terminal", exact: true });
  if ((await terminalToggle.getAttribute("aria-pressed")) !== "true") await terminalToggle.click();
  await page.getByRole("button", { name: "Start terminal" }).click();
  const output = page.getByRole("log", { name: "Terminal output" });
  await expect(output).toHaveText(/[$>#%]\s*$/u, { timeout: 20_000 });
  await page.locator(".terminal-output .xterm-helper-textarea").focus();
  await page.keyboard.type('sleep 300 & echo "pids:$$:$!"');
  await page.keyboard.press("Enter");
  await expect(output).toHaveText(/pids:\d+:\d+/u, { timeout: 20_000 });
  const match = /pids:(\d+):(\d+)/u.exec((await output.textContent()) ?? "");
  const shellPid = Number(match?.[1]);
  const jobPid = Number(match?.[2]);
  pids.push(shellPid, jobPid);
  expect(isRunning(shellPid)).toBe(true);
  expect(isRunning(jobPid)).toBe(true);
  const terminalId = await page.evaluate(
    async () => (await window.zli?.runtime.getProjection())?.terminals.at(-1)?.terminalId,
  );
  return { shellPid, jobPid, terminalId };
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
