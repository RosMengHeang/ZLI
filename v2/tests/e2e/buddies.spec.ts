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
    await pane.getByLabel("Job for Builder").fill("Add a login page");
    await pane.getByRole("button", { name: "Give job" }).click();

    // Auto picks the setup and says why; the job starts in its own chat.
    const card = pane.locator(".job-card").first();
    await expect(card.locator(".job-card-pick")).toBeVisible({ timeout: 60_000 });
    await shot("working");
    await expect(card.locator(".job-card-status")).toHaveText("Ready", { timeout: 120_000 });
    await expect(sidebar).toContainText("Done:");
    await shot("ready");

    // Builder's rule hands the finished job to Tester for a check.
    await sidebar.getByRole("button", { name: /Tester/u }).click();
    await expect(pane.locator(".job-card").first()).toContainText("Check Builder's work", { timeout: 60_000 });
    await shot("tester");
  } finally {
    await closeDesktop(fixture);
  }
});
