import { expect, test } from "@playwright/test";

import {
  closeDesktop,
  createGitFixture,
  type DesktopFixture,
  launchDesktop,
  openNewAgentOptions,
  sendChatMessage,
} from "./desktop-fixtures.js";

test("says when the usage limit resets and resumes the chat then when asked", async () => {
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

    await sendChatMessage(page, "[limit] refactor the parser");
    const note = page.locator(".chat-note.is-limit");
    await expect(note).toContainText("Usage limit reached");
    await expect(note).toContainText(/Resets at .+, in (1h 5\dm|2h)/u);
    // The log's own Continue would only hit the limit again.
    await expect(page.locator(".chat-continue")).toHaveCount(0);
    if (process.env.ZLI_E2E_SHOTS) await page.screenshot({ path: `${process.env.ZLI_E2E_SHOTS}/limit-1.png` });

    await note.getByRole("button", { name: "Resume at reset" }).click();
    await expect(note).toContainText("Continues by itself at");
    if (process.env.ZLI_E2E_SHOTS) await page.screenshot({ path: `${process.env.ZLI_E2E_SHOTS}/limit-2.png` });

    await note.getByRole("button", { name: "Cancel auto-resume" }).click();
    await expect(note.getByRole("button", { name: "Resume at reset" })).toBeVisible();
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});
