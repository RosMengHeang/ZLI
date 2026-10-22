import { expect, test } from "@playwright/test";

import { closeDesktop, createGitFixture, type DesktopFixture, launchDesktop } from "./desktop-fixtures.js";

test("queues messages while an agent is busy, removes them, and steers with Send now", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  const { root, repo } = await createGitFixture();
  let fixture: DesktopFixture | undefined;
  try {
    fixture = await launchDesktop(repo, root);
    const page = fixture.page;
    await expect(page.locator(".project-label")).toContainText("repo");

    await page.locator(".sidebar-new-agent").click();
    const newAgent = page.getByRole("dialog", { name: "New agent" });
    await newAgent.getByText("Codex", { exact: true }).click();
    await newAgent.getByText("Chat", { exact: true }).click();
    await newAgent.getByLabel("First message").fill("[approval] clean the build folder");
    await newAgent.getByRole("button", { name: "Start agent" }).click();
    const approval = page.getByRole("region", { name: "Approval request" });
    await expect(approval).toBeVisible({ timeout: 30_000 });

    const composer = page.getByRole("textbox", { name: "Message Codex" });
    const queue = page.getByRole("region", { name: "Queued messages" });
    await composer.fill("Update the docs");
    await page.getByRole("button", { name: "Queue message", exact: true }).click();
    await expect(queue.locator(".chat-queue-text")).toHaveText(["Update the docs"]);
    await composer.fill("Bump the version");
    await composer.press("Enter");
    await expect(queue.locator(".chat-queue-text")).toHaveText(["Update the docs", "Bump the version"]);
    await expect(queue.getByRole("button", { name: "Send now: Update the docs" })).toBeDisabled();

    await queue.getByRole("button", { name: "Remove from queue: Bump the version" }).click();
    await expect(queue.locator(".chat-queue-text")).toHaveText(["Update the docs"]);

    await approval.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(page.getByText("Mock response: Update the docs")).toBeVisible({ timeout: 20_000 });
    await expect(queue).toHaveCount(0);
    await expect(page.getByText("Bump the version")).toHaveCount(0);

    await composer.fill("[hold] keep working");
    await composer.press("Enter");
    await expect(page.getByRole("button", { name: "Queue message", exact: true })).toBeVisible({ timeout: 20_000 });
    await composer.fill("Change of plan, stop and fix the tests");
    await composer.press("Enter");
    await queue.getByRole("button", { name: "Send now: Change of plan, stop and fix the tests" }).click();
    await expect(page.getByText("Mock response: Change of plan, stop and fix the tests")).toBeVisible({
      timeout: 20_000,
    });
    await expect(queue).toHaveCount(0);
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});
