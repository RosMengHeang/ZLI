import { expect, test } from "@playwright/test";

import {
  closeDesktop,
  createGitFixture,
  type DesktopFixture,
  launchDesktop,
  openNewAgentOptions,
  sendChatMessage,
} from "./desktop-fixtures.js";

test("shows a chat's context use, plan limits in the sidebar, and the Usage page", async () => {
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
    await sendChatMessage(page, "[usage] summarize the repo");
    await expect(page.locator(".chat-log").getByText("Mock response: [usage] summarize the repo")).toBeVisible({
      timeout: 30_000,
    });
    // The chat's context use is in the computer column's Context card.
    await expect(page.locator(".ov-context-big").first()).toHaveText(/^7% used/u);

    // Plan limits show from the start: folded, one line in the footer for the selected agent's login, the Codex
    // chat at its fullest limit. Settings moves to an icon beside it.
    const limits = page.getByRole("button", { name: "Plan limits", exact: true });
    const card = page.locator(".sidebar-usage-strip");
    await expect(limits).toHaveAttribute("aria-expanded", "false");
    const line = page.locator(".sidebar-footer .usage-strip-summary");
    // Each window of the limit, the 5-hour one and the weekly one, with how long until it resets.
    await expect(line).toContainText("5h34%");
    await expect(line).toContainText("wk12%");
    await expect(line.locator(".provider-mark-codex")).toBeVisible();
    await expect(page.locator(".sidebar-footer").getByRole("button", { name: "Settings", exact: true })).toHaveText("");
    await expect(card).toHaveCount(0);
    // Unfolded, every agent that reports limits gets a row.
    await limits.click();
    await expect(limits).toHaveAttribute("aria-expanded", "true");
    await expect(card.locator(".usage-strip-row")).toHaveCount(7);
    await expect(card.locator(".usage-strip-name").first()).toHaveText("Claude Code");
    await expect(card.locator(".usage-strip-window-label").first()).toHaveText("5h");
    await expect(card.locator(".usage-strip-window-percent").first()).toHaveText("86%");
    // Every circle says when it resets, the same way; a narrow card keeps just the countdown.
    await expect(card.locator(".usage-strip-window-reset").first()).toHaveText(/^Resets in \d+m/u);
    // Choose agents opens Settings on Providers, where the sidebar's usage is set up.
    await card.getByRole("button", { name: "Choose agents" }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings.getByRole("tab", { name: "Providers" })).toHaveAttribute("aria-selected", "true");
    // Pinned there, the line shows that agent's limit instead of the selected chat's.
    // Settings scrolls to the section as it opens, and a scroll closes an open picker, so open it once it holds.
    const footerAgent = settings.getByRole("button", { name: /^Agent in the footer/u });
    await expect(async () => {
      if ((await footerAgent.getAttribute("aria-expanded")) !== "true") await footerAgent.click();
      await page.getByRole("option", { name: /^Cursor/u }).click({ timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
    await page.keyboard.press("Escape");
    await expect(settings).toHaveCount(0);
    await expect(line.locator(".provider-mark-cursor-agent")).toBeVisible();

    // Token use and cost have their own page in Settings.
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await settings.getByRole("tab", { name: "Usage", exact: true }).click();
    await expect(settings.getByRole("tab", { name: "Usage", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(settings.locator(".settings-page-title")).toHaveText("Usage");
    await page.keyboard.press("Escape");
    await expect(settings).toHaveCount(0);
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});
