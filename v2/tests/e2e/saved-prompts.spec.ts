import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import {
  closeDesktop,
  createGitFixture,
  type DesktopFixture,
  launchDesktop,
  openNewAgentOptions,
} from "./desktop-fixtures.js";

test("inserts a project's shared prompts with / in the composer", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  const { root, repo } = await createGitFixture();
  await writeFile(
    join(repo, "zli.json"),
    JSON.stringify({ version: 1, prompts: [{ name: "Inspect", prompt: "inspect workspace" }] }),
    "utf8",
  );
  let fixture: DesktopFixture | undefined;
  try {
    fixture = await launchDesktop(repo, root);
    const page = fixture.page;
    await expect(page.locator(".project-label")).toContainText("repo");
    // Electron keeps one profile between test runs, so personal prompts from an earlier run would show up.
    await page.evaluate(() => window.localStorage.removeItem("zli.prompts.v1"));
    await page.reload();
    await expect(page.locator(".project-label")).toContainText("repo", { timeout: 20_000 });

    await openNewAgentOptions(page);
    const newAgent = page.getByRole("dialog", { name: "New agent" });
    await newAgent.getByText("Codex", { exact: true }).click();
    await newAgent.getByText("Chat", { exact: true }).click();
    await newAgent.getByRole("button", { name: "Start agent" }).click();

    const composer = page.getByRole("textbox", { name: "Message Codex" });
    await expect(composer).toBeEnabled({ timeout: 30_000 });
    await composer.fill("/insp");
    const options = page.getByRole("listbox", { name: "Saved prompts" });
    await expect(options.getByRole("option")).toHaveCount(1);
    await expect(options.getByRole("option")).toContainText("Inspect");
    await composer.press("Enter");
    await expect(composer).toHaveValue("inspect workspace");
    await expect(options).toHaveCount(0);
    await composer.press("Enter");
    await expect(page.locator(".chat-log").getByText("Mock response: inspect workspace")).toBeVisible({
      timeout: 30_000,
    });
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});
