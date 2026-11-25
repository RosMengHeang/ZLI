import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, type Page, test } from "@playwright/test";

import {
  closeDesktop,
  createGitFixture,
  type DesktopFixture,
  git,
  launchDesktop,
  openNewAgentOptions,
} from "./desktop-fixtures.js";

async function startChat(page: Page, name: string) {
  const dialog = page.getByRole("dialog", { name: "New agent" });
  await dialog.getByText("Codex", { exact: true }).click();
  await dialog.getByText("Chat", { exact: true }).click();
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await dialog.getByRole("button", { name: "Start agent" }).click();
  await expect(page.getByRole("textbox", { name: `Message ${name}` })).toBeEnabled({ timeout: 30_000 });
}

test("opens a new chat in a newly added project, without the New agent dialog", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  const { root, repo } = await createGitFixture();
  const added = join(root, "guider-crm");
  await mkdir(added, { recursive: true });
  await writeFile(join(added, "README.md"), "# guider-crm\n", "utf8");
  await git(added, ["init"]);
  await git(added, ["config", "user.email", "zli-e2e@example.invalid"]);
  await git(added, ["config", "user.name", "ZLI E2E"]);
  await git(added, ["add", "README.md"]);
  await git(added, ["commit", "-m", "fixture"]);
  let fixture: DesktopFixture | undefined;
  try {
    fixture = await launchDesktop(repo, root);
    const page = fixture.page;
    await openNewAgentOptions(page);
    await startChat(page, "Alpha");

    // The native folder picker can't be driven from the test, so it answers with the second repository.
    await fixture.app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, added);
    await page.locator(".sidebar-add-project").click();

    // Adding a folder goes straight to a new chat there, with the default agent.
    await expect(page.locator(".composer-workspace .is-folder")).toContainText("guider-crm", { timeout: 30_000 });
    await expect(page.getByRole("dialog", { name: "New agent" })).toHaveCount(0);
    // The first chat waits in the sidebar.
    await expect(page.locator(".session-row", { hasText: "Alpha" })).toBeVisible();

    // The palette's New agent with options still opens on the added project.
    await openNewAgentOptions(page);
    const newAgent = page.getByRole("dialog", { name: "New agent" });
    await expect(newAgent.getByRole("button", { name: "Project: guider-crm" })).toBeVisible();
    await startChat(page, "Beta");
    await expect(page.getByRole("textbox", { name: "Message Beta" })).toBeVisible();
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});
