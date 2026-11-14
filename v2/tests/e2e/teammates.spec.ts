import { expect, test } from "@playwright/test";

import {
  closeDesktop,
  createGitFixture,
  type DesktopFixture,
  launchDesktop,
  openNewAgentOptions,
  sendChatMessage,
} from "./desktop-fixtures.js";

test("brings a second agent into a chat, talks to it by name, and keeps both in one conversation", async () => {
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
    await sendChatMessage(page, "Add a login page");
    await expect(page.locator(".chat-message-assistant").first()).toBeVisible({ timeout: 30_000 });

    // Bring in: the other agent joins under its buddy's name, and the message box calls it.
    await page.getByRole("button", { name: "Other agents" }).last().click();
    await page.getByRole("menuitem", { name: /^Bring in an agent/u }).click();
    await page.getByRole("menuitem", { name: /Codex/u }).click();
    const composer = page.getByRole("textbox", { name: /^Message / });
    await expect(composer).toHaveValue(/^@[A-Z][a-z]+ $/u);
    const guest = (await composer.inputValue()).slice(1).trim();
    const room = page.getByRole("region", { name: "Who is in this chat" });
    await expect(room).toContainText(guest);

    await composer.fill(`@${guest} review the login page`);
    await composer.press("Enter");
    await expect(page.locator(".room-speaker-name", { hasText: guest })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".room-speaker-name").first()).toHaveText("Codex");

    // Typing @ offers the people in the chat.
    await composer.fill(`@${guest.slice(0, 1)}`);
    await expect(page.getByRole("listbox", { name: "Teammates" })).toContainText(guest);
    await composer.press("Escape");
    await composer.fill("Thanks, fix what the guest found");
    await composer.press("Enter");
    await expect(page.locator(".chat-message-user").last()).toContainText("Thanks, fix what the guest found");

    if (process.env.ZLI_E2E_SHOT) await page.screenshot({ path: process.env.ZLI_E2E_SHOT });

    // A saved teammate joins the chat the first time it is called by name.
    await page.getByRole("button", { name: "Settings" }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings.getByRole("tab", { name: "Teammates" }).click();
    await settings.getByRole("button", { name: "Add teammate" }).click();
    await settings.getByRole("button", { name: "Bean", exact: true }).click();
    await settings.getByRole("button", { name: "Jade", exact: true }).click();
    await settings.getByLabel("Name").fill("Reviewer");
    await settings.getByLabel("Instructions").fill("Look for missing tests.");
    if (process.env.ZLI_E2E_SHOT)
      await page.screenshot({ path: process.env.ZLI_E2E_SHOT.replace(".png", "-settings.png") });
    await settings.getByRole("button", { name: "Add teammate" }).click();
    await expect(settings).toContainText("@Reviewer");
    await page.keyboard.press("Escape");

    await composer.fill("@Rev");
    await expect(page.getByRole("listbox", { name: "Teammates" })).toContainText("joins when you send");
    await composer.press("Enter");
    await expect(composer).toHaveValue("@Reviewer ");
    await composer.pressSequentially("any missing tests?");
    await composer.press("Enter");
    await expect(page.locator(".room-speaker-name", { hasText: "Reviewer" })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".chat-message-assistant").last()).toContainText("Look for missing tests.");
  } finally {
    await closeDesktop(fixture);
  }
});
