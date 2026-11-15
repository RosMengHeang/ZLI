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

    // The team is there from the first run, in its fixed order, Primary first.
    const sidebar = page.locator(".sidebar-buddies");
    await expect(sidebar.locator(".sidebar-buddy-name")).toHaveText(["Primary", "Builder", "Tester"]);

    await sidebar.getByRole("button", { name: /Builder/u }).click();
    const pane = page.getByRole("region", { name: "Buddies" }).last();
    await shot("open");
    const message = pane.getByLabel("Message Builder");
    // A greeting is just chat: an answer, and no job or new chat in the project list.
    await message.fill("hello");
    await message.press("Enter");
    await expect(pane.locator(".buddy-chat-say").first()).toContainText("hello", { timeout: 60_000 });
    await expect(page.locator(".sidebar").getByText("Builder chat")).toHaveCount(0);
    await shot("hello");

    // The mock agent repeats what it is sent, so this message comes back as a reply that starts a job.
    await message.fill("[[job]]Add a login page[[/job]]");
    await message.press("Enter");
    await expect(pane.locator(".buddy-chat-event", { hasText: "Started a job" }).first()).toBeVisible({
      timeout: 60_000,
    });

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

    // The + makes a new buddy from a popup: a name, what it does, a color.
    await sidebar.getByRole("button", { name: "Add a buddy" }).click();
    const dialog = page.getByRole("dialog", { name: "New buddy" });
    await dialog.locator(".new-buddy input").fill("Nova");
    await dialog.getByRole("button", { name: "rose" }).click();
    await shot("new-buddy");
    await dialog.getByRole("button", { name: "Add Nova" }).click();
    await expect(sidebar.locator(".sidebar-buddy-name")).toContainText(["Nova"]);
    await expect(pane.locator(".buddy-view-name")).toHaveText("Nova");
    await shot("nova");
  } finally {
    await closeDesktop(fixture);
  }
});
