import { expect, test } from "@playwright/test";

import { closeDesktop, createGitFixture, type DesktopFixture, launchDesktop } from "./desktop-fixtures.js";

test("changes New agent defaults, branch names, and shortcuts from Settings", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  const { root, repo } = await createGitFixture();
  let fixture: DesktopFixture | undefined;
  // Window storage outlives the test profile, so the person's own settings are put back afterwards.
  let saved: string | null = null;
  try {
    fixture = await launchDesktop(repo, root);
    const page = fixture.page;
    saved = await page.evaluate(() => window.localStorage.getItem("zli.settings.v1"));
    await expect(page.locator(".project-label")).toContainText("repo");

    await page.getByRole("button", { name: "Settings" }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings.getByRole("combobox", { name: "Agent" }).selectOption("codex");
    await settings.getByRole("combobox", { name: "Work in" }).selectOption("chat");

    await settings.getByRole("tab", { name: "Worktrees" }).click();
    await settings.getByLabel("Branch name template").fill("task/{agent}-{random}");
    await expect(settings).toContainText("task/codex-k3f9");

    await settings.getByRole("tab", { name: "Shortcuts" }).click();
    await settings.getByRole("button", { name: /^New agent, .+\. Change shortcut$/u }).click();
    await page.keyboard.press("Control+Shift+Y");
    await expect(settings.getByRole("button", { name: /^New agent, .+Y\. Change shortcut$/u })).toBeVisible();

    await settings.getByRole("tab", { name: "Notifications" }).click();
    const notify = settings.getByRole("switch", { name: /Notify when an agent finishes/u });
    await expect(notify).toBeChecked();
    await notify.click();
    await expect(notify).not.toBeChecked();
    await expect(settings.getByRole("switch", { name: "Play a sound" })).toBeDisabled();
    await notify.click();

    await page.keyboard.press("Escape");
    await expect(settings).toHaveCount(0);

    await page.keyboard.press("Control+Shift+Y");
    const newAgent = page.getByRole("dialog", { name: "New agent" });
    await expect(newAgent).toBeVisible();
    await expect(newAgent.getByRole("radio", { name: /Codex/u })).toBeChecked();
    await expect(newAgent.getByRole("radio", { name: /Chat/u })).toBeChecked();
    await newAgent.getByRole("radio", { name: /New worktree/u }).check();
    await expect(newAgent.getByLabel("Branch name")).toHaveValue(/^task\/codex-[a-z0-9]{4}$/u);
  } finally {
    if (fixture) {
      await fixture.page
        .evaluate((value) => {
          if (value === null) window.localStorage.removeItem("zli.settings.v1");
          else window.localStorage.setItem("zli.settings.v1", value);
        }, saved)
        .catch(() => undefined);
      await closeDesktop(fixture);
    }
  }
});
