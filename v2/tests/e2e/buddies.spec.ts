import { expect, test } from "@playwright/test";

import { closeDesktop, createGitFixture, type DesktopFixture, launchDesktop } from "./desktop-fixtures.js";

test("starts a team, gives Builder a job, and gets a result card that Tester checks", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  test.setTimeout(180_000);
  const { root, repo } = await createGitFixture();
  let fixture: DesktopFixture | undefined;
  const shot = (name: string) =>
    process.env.ZLI_E2E_SHOT
      ? fixture?.page.screenshot({ path: process.env.ZLI_E2E_SHOT.replace(".png", `-${name}.png`) })
      : undefined;
  try {
    fixture = await launchDesktop(repo, root);
    const page = fixture.page;
    await expect(page.locator(".project-label")).toContainText("repo");

    // The sidebar offers a team before there is one.
    await page.locator(".sidebar-buddies .sidebar-buddy").click();
    const pane = page.getByRole("region", { name: "Buddies" }).last();
    await expect(pane).toContainText("A team that works for you");
    await shot("welcome");
    await pane.getByRole("button", { name: "Start with these three" }).click();

    // The team lists in its fixed order, Primary first.
    const sidebar = page.locator(".sidebar-buddies");
    await expect(sidebar.locator(".sidebar-buddy-name")).toHaveText(["Primary", "Builder", "Tester"]);

    await sidebar.getByRole("button", { name: /Builder/u }).click();
    const message = pane.getByLabel("Message Builder");
    await message.fill("Add a login page");
    await message.press("Enter");
    await expect(pane.locator(".buddy-chat-you").first()).toHaveText("Add a login page");

    // Auto picks the setup and says why; the job starts in its own chat.
    await shot("working");
    const card = pane.locator(".buddy-chat-card .job-card").first();
    // Auto's pick and its reason show as a line in the conversation.
    await expect(pane.locator(".buddy-chat-event", { hasText: " — " }).first()).toBeVisible({ timeout: 120_000 });
    await expect(card.getByRole("button", { name: "Open PR" })).toBeVisible({ timeout: 120_000 });
    await expect(sidebar).toContainText("Done:");
    await shot("ready");

    // Builder's rule hands the finished job to Tester for a check.
    await sidebar.getByRole("button", { name: /Tester/u }).click();
    await expect(pane.locator(".buddy-chat-event").first()).toContainText("Builder handed this on", {
      timeout: 60_000,
    });
    await shot("tester");
  } finally {
    await closeDesktop(fixture);
  }
});
