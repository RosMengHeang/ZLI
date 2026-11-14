import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, type Page, test } from "@playwright/test";

import {
  clickProjectAction,
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

test("points a newly added project at New agent until it has one", async () => {
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
    const newAgent = page.getByRole("dialog", { name: "New agent" });
    await expect(newAgent).toBeVisible();
    await expect(newAgent.getByRole("button", { name: "Project: guider-crm" })).toBeVisible();
    await newAgent.getByRole("button", { name: "Cancel" }).click();
    await expect(newAgent).toHaveCount(0);

    // The other project's tile stays where it was, with a note about the added project above the board.
    await expect(page.getByRole("textbox", { name: "Message Alpha" })).toBeVisible();
    const notice = page.locator(".board-project-notice");
    await expect(notice).toHaveText(/No chats in guider-crm yet./u);
    const project = page.getByRole("region", { name: "guider-crm" });
    // An empty project shows only its heading; starting a chat in it is in its menu.
    await expect(project).not.toContainText("No chats yet.");

    // The project's menu opens the dialog with every option, already on that project.
    await clickProjectAction(
      project.locator(".project-label"),
      project.getByRole("button", { name: "guider-crm actions" }),
    );
    await page.getByRole("menuitem", { name: "New agent with options…" }).click();
    await expect(newAgent.getByRole("button", { name: "Project: guider-crm" })).toBeVisible();
    await startChat(page, "Beta");

    await expect(notice).toHaveCount(0);
    // One chat fills the board; Alpha waits in the sidebar.
    await expect(page.getByRole("textbox", { name: "Message Beta" })).toBeVisible();
    await expect(page.locator(".session-row", { hasText: "Alpha" })).toBeVisible();
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});
