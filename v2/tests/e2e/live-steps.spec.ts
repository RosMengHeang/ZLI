import { expect, test } from "@playwright/test";

import {
  closeDesktop,
  createGitFixture,
  type DesktopFixture,
  launchDesktop,
  sendChatMessage,
} from "./desktop-fixtures.js";

test("shows each step live between the reply's text, and stops a turn from the composer", async () => {
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
    await newAgent.getByRole("button", { name: "Start agent" }).click();
    await sendChatMessage(page, "[steps] [slow] fix the routes");

    const status = page.locator(".chat-working");
    await expect(status).toBeVisible({ timeout: 10_000 });
    await expect(status.locator(".chat-working-time")).toHaveText(/^\d+s$/u);
    await expect(status).toContainText(/Reading (app|routes)\.ts/u, { timeout: 20_000 });
    await expect(status).toContainText("Editing routes.ts", { timeout: 20_000 });
    await expect(status).toContainText("Run the tests", { timeout: 20_000 });
    await expect(status).toHaveCount(0, { timeout: 20_000 });

    const log = page.getByRole("log", { name: "Agent conversation" });
    const order = await log
      .locator(".chat-message-assistant, .work-steps")
      .evaluateAll((nodes) =>
        nodes.map((node) => (node.classList.contains("work-steps") ? "steps" : (node.textContent ?? "").trim())),
      );
    expect(order).toEqual([
      "I'll look at the routes first.",
      "steps",
      "Found it. The route skips empty input, so I'll fix that.",
      "steps",
      "Done. The route now handles empty input and the tests pass.",
    ]);
    const explored = log.getByRole("button", { name: /Explored 2 files, 1 search/u });
    await explored.click();
    await expect(log.getByText("Read src/routes.ts")).toBeVisible();
    await expect(log.getByRole("button", { name: "Open src/routes.ts" })).toContainText("+4-1");
    await expect(log.getByText("Edit 5 lines")).toBeVisible();
    await log.getByRole("button", { name: /Run the tests/u }).click();
    await expect(log.locator(".step-detail")).toHaveText("$ npm test\n2 passed");

    await sendChatMessage(page, "[hold] keep working");
    const stop = page.getByRole("button", { name: "Stop Codex", exact: true });
    await expect(stop).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".chat-working-label")).toHaveText("Thinking");
    await stop.click();
    await expect(stop).toHaveCount(0, { timeout: 20_000 });
    await expect(page.locator(".chat-working")).toHaveCount(0);
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});
