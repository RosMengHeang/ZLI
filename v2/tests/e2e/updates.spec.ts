import { access } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { closeDesktop, createGitFixture, type DesktopFixture, launchDesktop } from "./desktop-fixtures.js";

test("never checks for updates in test launches and shows why in Settings", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  const { root, repo } = await createGitFixture();
  let fixture: DesktopFixture | undefined;
  try {
    fixture = await launchDesktop(repo, root);
    const page = fixture.page;
    await expect(page.locator(".project-label")).toContainText("repo");

    const status = await page.evaluate(() => window.zli?.updates?.check());
    expect(status?.state).toEqual({ status: "idle" });
    expect(status?.lastCheckedAt).toBeUndefined();
    expect(status?.disabledReason).toBeTruthy();
    expect(await page.evaluate(() => window.zli?.updates?.whatsNew())).toBeUndefined();
    await expect(page.locator(".update-pill")).toHaveCount(0);

    await page.getByRole("button", { name: "Settings" }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings.getByRole("tab", { name: "Updates" }).click();
    await expect(settings).toContainText(status?.disabledReason ?? "");
    await expect(settings).toContainText("Not checked yet");
    await expect(settings.getByRole("button", { name: "Check for updates" })).toBeDisabled();
    await expect(settings.getByRole("switch", { name: /Install updates automatically/u })).toBeChecked();
    await expect(settings.getByRole("switch", { name: /Install updates automatically/u })).toBeDisabled();
    await expect(settings.getByRole("combobox", { name: "Update channel" })).toHaveValue("stable");
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Help", exact: true }).click();
    const help = page.getByRole("dialog", { name: "Help and diagnostics" });
    const version = await page.evaluate(() => window.zli?.app.getVersion());
    await expect(help).toContainText(`ZLI ${version}`);

    // A launch that started the update service would have recorded its version here.
    await expect(access(join(root, "runtime.sqlite.updates.json"))).rejects.toThrow();
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});
