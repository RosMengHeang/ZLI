import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { closeDesktop, createGitFixture, type DesktopFixture, launchDesktop } from "./desktop-fixtures.js";

test("notifies when a background agent finishes and lets people turn notifications off", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  const { root, repo } = await createGitFixture();
  let fixture: DesktopFixture | undefined;
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  try {
    fixture = await launchDesktop(repo, root);
    const { app, page } = fixture;
    // CI desktops have no notification daemon, so shown notifications are recorded instead, and the
    // window reports itself unfocused so the agent counts as running in the background.
    await app.evaluate(({ BrowserWindow, Notification }) => {
      const shown: Array<{ title: string; body: string }> = [];
      Object.assign(globalThis, { zliShownNotifications: shown });
      Notification.isSupported = () => true;
      Notification.prototype.show = function show(this: Electron.Notification) {
        shown.push({ title: this.title, body: this.body });
      };
      const window = BrowserWindow.getAllWindows()[0];
      if (window) window.isFocused = () => false;
    });

    await page.keyboard.press(`${mod}+n`);
    const dialog = page.getByRole("dialog", { name: "New agent" });
    await dialog.getByText("Codex", { exact: true }).click();
    await dialog.getByText("Chat", { exact: true }).click();
    await dialog.getByRole("button", { name: "Start agent" }).click();
    const composer = page.getByRole("textbox", { name: "Message Codex" });
    await composer.fill("Summarize the README");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByText(/Mock response/u).first()).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(() => app.evaluate(() => (globalThis as { zliShownNotifications?: unknown[] }).zliShownNotifications))
      .toContainEqual(expect.objectContaining({ title: expect.stringMatching(/finished/u) }));

    await page.keyboard.press(`${mod}+k`);
    await page.getByRole("button", { name: "Turn off agent notifications" }).click();
    await expect
      .poll(async () => JSON.parse(await readFile(join(root, "runtime.sqlite.notifications.json"), "utf8")))
      .toMatchObject({ enabled: false });
    await page.keyboard.press(`${mod}+k`);
    await expect(page.getByRole("button", { name: "Turn on agent notifications" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Mute notification sound" })).toHaveCount(0);
    await page.keyboard.press("Escape");
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});
