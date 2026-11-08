import { expect, test } from "@playwright/test";
import { rm } from "node:fs/promises";

import {
  captureProcessTree,
  closeApp,
  closeDesktop,
  createGitFixture,
  launchDesktop,
  stopDesktopDaemon,
  type DesktopFixture,
} from "./desktop-fixtures.js";

// Two cold Electron launches plus a daemon stop take about a minute on Windows CI runners.
const RELAUNCH_TIMEOUT_MS = 180_000;

test("reconnects the Electron client after the local runtime process is restarted", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  const { root, repo } = await createGitFixture();
  let fixture: DesktopFixture | undefined;
  try {
    fixture = await launchDesktop(repo, root);
    const { page } = fixture;
    const restart = fixture.page.evaluate(() => window.zli?.test?.restartRuntime());
    await restart;
    const result = await expect
      .poll(
        async () => {
          try {
            const response = await page.evaluate(
              async (path) =>
                window.zli?.runtime.dispatch({
                  protocolVersion: 1,
                  commandId: "00000000-0000-4000-8000-000000000123",
                  command: { type: "project.register", path },
                }),
              repo,
            );
            return response?.accepted === false ? response.error.message : "unexpected-accept";
          } catch {
            return "runtime-reconnecting";
          }
        },
        { timeout: 30_000 },
      )
      .toBe(`Project is already registered: ${repo}`);
    expect(result).toBeUndefined();
    await fixture.page.reload();
    await expect(fixture.page.getByRole("status").filter({ hasText: "Runtime connected" })).toBeVisible();
    await expect(fixture.page.locator(".project-label")).toContainText("repo");
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});

test("restores the durable workspace after the Electron main process exits and relaunches", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  test.setTimeout(RELAUNCH_TIMEOUT_MS);
  const { root, repo } = await createGitFixture();
  let fixture: DesktopFixture | undefined;
  try {
    fixture = await launchDesktop(repo, root);
    await expect(fixture.page.locator(".project-label")).toContainText("repo");
    await closeApp(fixture);
    await stopDesktopDaemon(root);
    fixture = undefined;

    fixture = await launchDesktop(repo, root);
    await expect(fixture.page.locator(".project-label")).toContainText("repo");
  } finally {
    if (fixture) await closeDesktop(fixture);
    else await rm(root, { recursive: true, force: true });
  }
});

test("restores the durable workspace after an abrupt Electron main-process exit", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  test.setTimeout(RELAUNCH_TIMEOUT_MS);
  const { root, repo } = await createGitFixture();
  let fixture: DesktopFixture | undefined;
  try {
    fixture = await launchDesktop(repo, root);
    await expect(fixture.page.locator(".project-label")).toContainText("repo");
    const firstRun = fixture;
    const mainProcess = firstRun.app.process();
    const processTree = await captureProcessTree(mainProcess.pid);
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
      mainProcess.once("exit", (code, signal) => resolveExit({ code, signal }));
    });
    await firstRun.page.evaluate(() => {
      const testApi = window.zli?.test as { crashMain?: () => Promise<unknown> } | undefined;
      void testApi?.crashMain?.();
    });
    const exitResult = await Promise.race([
      exited,
      new Promise<undefined>((resolveTimeout) => setTimeout(() => resolveTimeout(undefined), 2_500)),
    ]);
    expect(exitResult).toBeDefined();

    fixture = undefined;
    await closeApp(firstRun, { stopTerminals: false, processTree, child: mainProcess });
    await stopDesktopDaemon(root);
    fixture = await launchDesktop(repo, root);
    await expect(fixture.page.locator(".project-label")).toContainText("repo");
  } finally {
    if (fixture) await closeDesktop(fixture);
    else await rm(root, { recursive: true, force: true });
  }
});
