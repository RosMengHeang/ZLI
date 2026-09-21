import { expect, test } from "@playwright/test";

import { closeDesktop, createGitFixture, launchDesktop, type DesktopFixture } from "./desktop-fixtures.js";

test("reconnects the Electron client after the local runtime process is restarted", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  const { root, repo } = await createGitFixture();
  let fixture: DesktopFixture | undefined;
  try {
    fixture = await launchDesktop(repo, root);
    const restart = fixture.page.evaluate(() => window.zli?.test?.restartRuntime());
    await restart;
    const result = await expect.poll(async () => {
      try {
        const response = await fixture!.page.evaluate(async (path) => window.zli?.runtime.dispatch({
          protocolVersion: 1,
          commandId: "00000000-0000-4000-8000-000000000123",
          command: { type: "project.register", path },
        }), repo);
        return response?.accepted === false ? response.error.message : "unexpected-accept";
      } catch {
        return "runtime-reconnecting";
      }
    }, { timeout: 30_000 }).toBe(`Project is already registered: ${repo}`);
    expect(result).toBeUndefined();
    await fixture.page.reload();
    await expect(fixture.page.getByText("Local runtime")).toBeVisible();
    await expect(fixture.page.locator(".project-label")).toContainText("repo");
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});
