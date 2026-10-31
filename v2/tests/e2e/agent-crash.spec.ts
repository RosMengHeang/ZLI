import { expect, test } from "@playwright/test";

import {
  closeDesktop,
  createGitFixture,
  type DesktopFixture,
  launchDesktop,
  sendChatMessage,
} from "./desktop-fixtures.js";

test("starts the agent again when a message follows a crash of its process", async () => {
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

    await sendChatMessage(page, "[crash] start the build");
    await expect(page.getByText("Codex is stopped. Your next message picks up where it left off.")).toBeVisible({
      timeout: 30_000,
    });

    await sendChatMessage(page, "Pick the build back up");
    await expect(page.getByText("Mock response: Pick the build back up")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Session already exists/u)).toHaveCount(0);

    await sendChatMessage(page, "[crash] once more");
    await expect(page.getByText("Codex is stopped. Your next message picks up where it left off.")).toBeVisible({
      timeout: 30_000,
    });
    await sendChatMessage(page, "Still with me?");
    await expect(page.getByText("Mock response: Still with me?")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Session already exists/u)).toHaveCount(0);
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});
