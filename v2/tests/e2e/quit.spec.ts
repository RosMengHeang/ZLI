import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import {
  captureProcessTree,
  closeDesktop,
  createGitFixture,
  type DesktopFixture,
  launchDesktop,
} from "./desktop-fixtures.js";

test("leaves no ZLI process running after it quits with a terminal open", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  test.setTimeout(120_000);
  const { root, repo } = await createGitFixture();
  let fixture: DesktopFixture | undefined;
  try {
    fixture = await launchDesktop(repo, root);
    const { page } = fixture;
    await page.getByRole("button", { name: "Create worktree", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Create worktree" });
    await dialog.getByLabel("Branch").fill("quit");
    await dialog.getByRole("button", { name: "Create worktree" }).click();
    const worktree = page.getByRole("button", { name: /quit/iu });
    await expect(worktree).toContainText("Ready", { timeout: 30_000 });
    await worktree.click();
    const terminalToggle = page.getByRole("button", { name: "Terminal", exact: true });
    if ((await terminalToggle.getAttribute("aria-pressed")) !== "true") await terminalToggle.click();
    await page.getByRole("button", { name: "Start terminal" }).click();
    await expect
      .poll(async () =>
        page.evaluate(async () => (await window.zli?.runtime.getProjection())?.terminals.at(-1)?.status),
      )
      .toBe("running");

    const endpoint = JSON.parse(await readFile(join(root, "runtime.sqlite.daemon.json"), "utf8")) as { pid: number };
    const main = fixture.app.process();
    const pids = [
      ...new Set([...(await captureProcessTree(main.pid)), ...(await captureProcessTree(endpoint.pid)), endpoint.pid]),
    ];
    expect(pids.length).toBeGreaterThan(1);
    const exited = new Promise<void>((resolveExit) => main.once("exit", () => resolveExit()));

    await fixture.app.close();
    await exited;
    fixture = undefined;

    await expect.poll(() => pids.filter(isRunning), { timeout: 15_000 }).toEqual([]);
  } finally {
    if (fixture) await closeDesktop(fixture);
    else await rm(root, { recursive: true, force: true });
  }
});

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
