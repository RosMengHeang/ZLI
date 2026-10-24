import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import {
  closeDesktop,
  createGitFixture,
  type DesktopFixture,
  launchDesktop,
  sendChatMessage,
} from "./desktop-fixtures.js";

const API_KEY = "sk-e2e-account-key-9876";

test("runs a chat under an API key account picked in the New agent dialog", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  const { root, repo } = await createGitFixture();
  let fixture: DesktopFixture | undefined;
  try {
    fixture = await launchDesktop(repo, root);
    const page = fixture.page;
    await expect(page.locator(".project-label")).toContainText("repo");

    await page.getByRole("button", { name: "Settings" }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings.getByRole("tab", { name: "Accounts" }).click();
    const codex = settings.getByRole("region", { name: "Codex accounts" });
    await codex.getByRole("button", { name: "Add Codex account" }).click();
    const form = settings.getByRole("form", { name: "New Codex account" });
    await form.getByLabel("Name").fill("Work key");
    await form.getByRole("button", { name: /^Kind:/u }).click();
    await page.getByRole("option", { name: "API key", exact: true }).click();
    await form.getByRole("textbox", { name: "API key" }).fill(API_KEY);
    await form.getByRole("button", { name: "Add account" }).click();
    await expect(form).toHaveCount(0);
    await expect(codex).toContainText("Work key");
    await expect(codex).toContainText("API key …9876");
    await expect(settings).not.toContainText(API_KEY);

    const file = join(root, "accounts.json");
    expect(await readFile(file, "utf8")).toContain(API_KEY);
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
    await page.keyboard.press("Escape");
    await expect(settings).toHaveCount(0);

    await page.locator(".sidebar-new-agent").click();
    const newAgent = page.getByRole("dialog", { name: "New agent" });
    await newAgent.getByText("Codex", { exact: true }).click();
    await newAgent.getByRole("button", { name: "Account: Usual login" }).click();
    await page.getByRole("option", { name: "Work key", exact: true }).click();
    await expect(newAgent.getByRole("button", { name: "Account: Work key" })).toBeVisible();
    await newAgent.getByText("Chat", { exact: true }).click();
    await newAgent.getByRole("button", { name: "Start agent" }).click();

    await expect(page.locator(".agent-tile .tile-account")).toHaveText("Work key");
    await sendChatMessage(page, "[account] which login");
    await expect(page.getByText("Account environment: CODEX_HOME")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: /, Codex \(Work key\),/u })).toBeVisible();
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});
