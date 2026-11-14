import { expect, test } from "@playwright/test";

import {
  closeDesktop,
  createGitFixture,
  type DesktopFixture,
  launchDesktop,
  openNewAgentOptions,
  sendChatMessage,
} from "./desktop-fixtures.js";

test("queues messages while an agent is busy, removes them, and steers with Send now", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  const { root, repo } = await createGitFixture();
  let fixture: DesktopFixture | undefined;
  try {
    fixture = await launchDesktop(repo, root);
    const page = fixture.page;
    await expect(page.locator(".project-label")).toContainText("repo");

    await openNewAgentOptions(page);
    const newAgent = page.getByRole("dialog", { name: "New agent" });
    await newAgent.getByText("Codex", { exact: true }).click();
    await newAgent.getByText("Chat", { exact: true }).click();
    await newAgent.getByRole("button", { name: "Start agent" }).click();
    // [hold] keeps the turn running, so later messages wait in the queue above the message box.
    await sendChatMessage(page, "[hold] keep working");
    const composer = page.getByRole("textbox", { name: "Message Codex" });
    const queue = page.getByRole("region", { name: "Queued messages" });
    const queueButton = page.getByRole("button", { name: "Queue message", exact: true });
    await expect(queueButton).toBeVisible({ timeout: 30_000 });

    await composer.fill("Update the docs");
    await queueButton.click();
    await expect(queue.locator(".chat-queue-text")).toHaveText(["Update the docs"]);
    await composer.fill("Bump the version");
    // The turn can start before the first send settles; Enter is ignored until it does.
    await expect(queueButton).toBeEnabled();
    await composer.press("Enter");
    await expect(queue.locator(".chat-queue-text")).toHaveText(["Update the docs", "Bump the version"]);

    await queue.getByRole("button", { name: "Remove from queue: Bump the version" }).click();
    await expect(queue.locator(".chat-queue-text")).toHaveText(["Update the docs"]);

    await queue.getByRole("button", { name: "Send now: Update the docs" }).click();
    await expect(page.locator(".chat-log").getByText("Mock response: Update the docs")).toBeVisible({
      timeout: 20_000,
    });
    await expect(queue).toHaveCount(0);
    await expect(page.getByText("Bump the version")).toHaveCount(0);
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});
