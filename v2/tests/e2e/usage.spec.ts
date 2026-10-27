import { expect, test } from "@playwright/test";

import {
  closeDesktop,
  createGitFixture,
  type DesktopFixture,
  launchDesktop,
  sendChatMessage,
} from "./desktop-fixtures.js";

test("shows a chat's context use and totals turn usage on the Usage page", async () => {
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
    await sendChatMessage(page, "[usage] summarize the repo");
    await expect(page.getByText("Mock response: [usage] summarize the repo")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".composer-context [aria-hidden]")).toHaveText("7% context");

    const limits = page.getByRole("button", { name: "Plan limits", exact: true });
    await expect(limits.locator(".usage-strip-name")).toHaveText(["Claude Code", "Codex"]);
    await expect(limits.locator(".usage-strip-window-label")).toHaveText(["5h", "Week", "Fable", "5h", "Week"]);
    await expect(limits.locator(".usage-strip-window-percent")).toHaveText(["86%", "41%", "92%", "34%", "12%"]);
    // Every circle says when it resets: a countdown and the local time.
    await expect(limits.locator(".usage-strip-window-reset").first()).toHaveText(/^\d+m · \d{1,2}:\d{2}\s?[AP]M$/u);
    await limits.click();
    await expect(page.getByRole("dialog", { name: "Usage" })).toBeVisible();
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Usage", exact: true }).click();
    const usage = page.getByRole("dialog", { name: "Usage" });
    const summary = usage.locator(".usage-summary");
    await expect(summary).toContainText("Turns1");
    await expect(summary).toContainText("12k8k cached");
    await expect(summary).toContainText("$0.04");
    await expect(usage.getByRole("row", { name: /\[usage\] summarize the repo/u })).toContainText("1.3k");

    await usage.getByRole("button", { name: "Today", exact: true }).click();
    await expect(usage.getByRole("button", { name: "Today", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(summary).toContainText("Turns1");
    await page.keyboard.press("Escape");
    await expect(usage).toHaveCount(0);
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});
