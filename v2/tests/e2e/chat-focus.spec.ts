import { expect, type Page, test } from "@playwright/test";

import { closeDesktop, createGitFixture, type DesktopFixture, launchDesktop } from "./desktop-fixtures.js";

async function startChat(page: Page, name: string) {
  await page.locator(".sidebar-new-agent").click();
  const dialog = page.getByRole("dialog", { name: "New agent" });
  await dialog.getByText("Codex", { exact: true }).click();
  await dialog.getByText("Chat", { exact: true }).click();
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await dialog.getByRole("button", { name: "Start agent" }).click();
  await expect(page.getByRole("textbox", { name: `Message ${name}` })).toBeEnabled({ timeout: 30_000 });
}

test("switching to a chat agent puts the cursor in its message box", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  const { root, repo } = await createGitFixture();
  let fixture: DesktopFixture | undefined;
  try {
    fixture = await launchDesktop(repo, root);
    const page = fixture.page;
    await startChat(page, "Alpha");
    await startChat(page, "Beta");
    const alpha = page.getByRole("textbox", { name: "Message Alpha" });
    const beta = page.getByRole("textbox", { name: "Message Beta" });
    await expect(beta).toBeFocused();

    await page
      .getByRole("region", { name: /^Alpha,/u })
      .locator(".tile-header")
      .click();
    await expect(alpha).toBeFocused();

    await page.locator(".session-row", { hasText: "Beta" }).click();
    await expect(beta).toBeFocused();

    await page.locator(".session-row", { hasText: "Alpha" }).click();
    await expect(alpha).toBeFocused();
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});
