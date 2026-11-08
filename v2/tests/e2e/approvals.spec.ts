import { expect, test } from "@playwright/test";

import {
  closeDesktop,
  createGitFixture,
  launchDesktop,
  type DesktopFixture,
  sendChatMessage,
} from "./desktop-fixtures.js";

test("shows approvals and questions in plain words and answers them from the chat", async () => {
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
    await sendChatMessage(page, "[approval] clean the build folder");

    const approval = page.getByRole("region", { name: "Approval request" });
    await expect(approval).toBeVisible({ timeout: 30_000 });
    await expect(approval.locator(".chat-request-heading")).toHaveText("Run a command");
    await expect(approval.locator(".chat-request-field dd")).toHaveText("echo integration-check");
    await expect(approval.locator(".chat-request-raw pre")).toBeHidden();
    await approval.getByRole("button", { name: "Approve for this chat" }).click();
    await expect(approval).toHaveCount(0);

    const composer = page.getByRole("textbox", { name: "Message Codex" });
    await composer.fill("[input] which branch?");
    await composer.press("Enter");
    const question = page.getByRole("region", { name: "Input request" });
    await expect(question).toBeVisible({ timeout: 20_000 });
    const send = question.getByRole("button", { name: "Send answer" });
    await expect(send).toBeDisabled();
    await question.getByRole("textbox", { name: "Mock provider input" }).fill("main");
    await send.click();
    await expect(question).toHaveCount(0);
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});

test("clears an open approval when the turn is stopped or ZLI restarts, so the chat can go on", async () => {
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

    const approval = page.getByRole("region", { name: "Approval request" });
    const attention = page.getByRole("complementary", { name: "Attention required" });
    const composer = page.getByRole("textbox", { name: "Message Codex" });
    await sendChatMessage(page, "[approval] clean the build folder");
    await expect(approval).toBeVisible({ timeout: 30_000 });
    await expect(attention).toContainText("Agent approval required");

    await page.getByRole("button", { name: "Stop Codex" }).click();
    await expect(approval).toHaveCount(0);
    await expect(attention).toHaveCount(0);
    await composer.fill("hello after stop");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled({ timeout: 20_000 });
    await composer.press("Enter");
    await expect(page.getByText("Mock response: hello after stop")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("region", { name: "Queued messages" })).toHaveCount(0);

    await composer.fill("[approval] clean the build folder again");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled({ timeout: 20_000 });
    await composer.press("Enter");
    await expect(approval).toBeVisible({ timeout: 20_000 });
    await page.evaluate(() => window.zli?.test?.restartRuntime());
    await expect
      .poll(
        async () => {
          try {
            return await page.evaluate(async () => {
              const projection = await window.zli?.runtime.getProjection();
              return {
                status: projection?.threads[0]?.status,
                requests: projection?.requests?.length ?? 0,
                attention: projection?.attention.length ?? 0,
              };
            });
          } catch {
            return "runtime-reconnecting";
          }
        },
        { timeout: 30_000 },
      )
      .toEqual({ status: "stopped", requests: 0, attention: 0 });
    await page.reload();
    await expect(page.getByRole("status").filter({ hasText: "Runtime connected" })).toBeVisible();
    await expect(page.getByText("Mock response: hello after stop")).toBeVisible({ timeout: 20_000 });
    await expect(approval).toHaveCount(0);
    await expect(attention).toHaveCount(0);
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});
