import { expect, test } from "@playwright/test";

import { closeDesktop, createGitFixture, type DesktopFixture, launchDesktop } from "./desktop-fixtures.js";

test("asks once before agents work in a project, and starts nothing until the answer is yes", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  const { root, repo } = await createGitFixture();
  let fixture: DesktopFixture | undefined;
  try {
    fixture = await launchDesktop(repo, root, { trustAgents: false });
    const { page } = fixture;
    await expect(page.locator(".project-label")).toContainText("repo");
    const trust = page.getByRole("dialog", { name: "Let agents work in this project" });
    const composer = page.getByRole("textbox", { name: "Message Codex" });
    const startChat = async () => {
      await page.locator(".sidebar-new-agent").click();
      const newAgent = page.getByRole("dialog", { name: "New agent" });
      await newAgent.getByText("Codex", { exact: true }).click();
      await newAgent.getByText("Chat", { exact: true }).click();
      await newAgent.getByRole("button", { name: "Start agent" }).click();
    };

    await startChat();
    await expect(trust).toBeVisible();
    await expect(trust).toContainText(repo);
    await trust.getByRole("button", { name: "Not now" }).click();
    await expect(
      page.getByText("Agents start in this project only after you let them work here.").first(),
    ).toBeVisible();
    await expect(composer).toHaveCount(0);

    await startChat();
    await trust.getByRole("button", { name: "Let agents work" }).click();
    await expect(trust).toHaveCount(0);
    await expect(composer).toBeVisible({ timeout: 30_000 });

    await startChat();
    await expect(composer.first()).toBeVisible({ timeout: 30_000 });
    await expect(trust).toHaveCount(0);
  } finally {
    await closeDesktop(fixture, root);
  }
});
