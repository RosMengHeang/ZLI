import { expect, test } from "@playwright/test";

import {
  closeDesktop,
  createGitFixture,
  type DesktopFixture,
  launchDesktop,
  sendChatMessage,
} from "./desktop-fixtures.js";

test("hands a chat to another agent, starts a scratch chat, and attaches a window", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  const { root, repo } = await createGitFixture();
  let fixture: DesktopFixture | undefined;
  const palette = process.platform === "darwin" ? "Meta+k" : "Control+k";
  try {
    fixture = await launchDesktop(repo, root);
    const page = fixture.page;
    await expect(page.locator(".project-label")).toContainText("repo");

    await page.locator(".sidebar-new-agent").click();
    const newAgent = page.getByRole("dialog", { name: "New agent" });
    await newAgent.getByText("Codex", { exact: true }).click();
    await newAgent.getByText("Chat", { exact: true }).click();
    await newAgent.getByRole("button", { name: "Start agent" }).click();
    await sendChatMessage(page, "Fix the login form");
    await expect(page.getByText(/Mock response: Fix the login form/u)).toBeVisible({ timeout: 30_000 });

    const firstTile = page.locator(".agent-tile").first();
    await firstTile.getByRole("button", { name: "Continue with another agent" }).click();
    const handoff = page.getByRole("dialog", { name: "Continue with another agent" });
    await expect(handoff.getByRole("region", { name: "Opening message preview" })).toContainText(
      "Continue: Fix the login form",
    );
    await expect(handoff).toContainText("handoff-conversation.md");
    await handoff.getByLabel("Next step").fill("Add a test for the empty password case.");
    await expect(handoff.getByRole("switch", { name: /Stop Codex and close its tile/u })).toBeChecked();
    await handoff.getByRole("button", { name: "Continue with Codex" }).click();
    await expect(handoff).toHaveCount(0);

    await expect(page.locator(".agent-tile")).toHaveCount(1);
    const tile = page.locator(".agent-tile").first();
    await expect(tile.locator(".tile-title")).toHaveText("Continue: Fix the login form", { timeout: 30_000 });
    await expect(tile.locator(".chat-attachments")).toContainText("handoff-conversation.md", { timeout: 30_000 });
    await expect(tile.getByText(/Mock response: Continue: Fix the login form/u)).toBeVisible({ timeout: 30_000 });

    await page.keyboard.press(palette);
    const commands = page.getByRole("dialog", { name: "Command palette" });
    await commands.getByRole("textbox", { name: "Search commands" }).fill("scratch");
    await commands.getByRole("textbox", { name: "Search commands" }).press("Enter");
    await expect(page.locator(".project-label", { hasText: "Scratch" })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".agent-tile")).toHaveCount(2);
    // The scratch tile shows a placeholder until its chat starts, so its composer is looked up inside it.
    const scratchTile = page.locator(".agent-tile").last();
    const scratch = scratchTile.getByRole("textbox", { name: "Message Codex" });
    await expect(scratch).toBeEditable({ timeout: 30_000 });
    await scratch.fill("What does HTTP 418 mean?");
    await expect(scratchTile.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await scratch.press("Enter");
    await expect(page.getByText(/Mock response: What does HTTP 418 mean\?/u)).toBeVisible({ timeout: 30_000 });
    const scratchPath = await page.evaluate(async () => {
      const projection = await window.zli?.runtime.getProjection();
      return projection?.projects.find((project) => project.name === "Scratch")?.path ?? "";
    });
    expect(scratchPath.replaceAll("\\", "/")).toContain(`${root.replaceAll("\\", "/")}/Scratch`);

    // Other platforms need screen recording permission that CI runners cannot grant.
    if (process.platform === "win32") {
      await scratchTile.getByRole("button", { name: "Add files and more", exact: true }).click();
      await page.getByRole("menuitem", { name: /^Attach a window/u }).click();
      const picker = scratchTile.getByRole("region", { name: "Attach a window" });
      const source = picker.locator(".capture-source").first();
      await expect(source).toBeVisible({ timeout: 20_000 });
      await source.click();
      await expect(picker).toHaveCount(0, { timeout: 20_000 });
      await expect(scratchTile.getByRole("list", { name: "Attachments" })).toContainText(".png");
    }
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});
