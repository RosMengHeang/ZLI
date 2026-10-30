import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, type Page, test } from "@playwright/test";

import { closeDesktop, createGitFixture, type DesktopFixture, git, launchDesktop } from "./desktop-fixtures.js";

test("swaps project boards and brings each back as it was, without stopping agents", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  const { root, repo } = await createGitFixture();
  const shop = join(root, "shop");
  await mkdir(shop, { recursive: true });
  await writeFile(join(shop, "README.md"), "# Shop\n", "utf8");
  await git(shop, ["init"]);
  await git(shop, ["config", "user.email", "zli-e2e@example.invalid"]);
  await git(shop, ["config", "user.name", "ZLI E2E"]);
  await git(shop, ["add", "README.md"]);
  await git(shop, ["commit", "-m", "fixture"]);
  let fixture: DesktopFixture | undefined;
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  try {
    fixture = await launchDesktop(repo, root);
    const { page } = fixture;
    // Tiles from earlier runs live in localStorage and would crowd the grid.
    await page.evaluate(() => localStorage.removeItem("zli.workbench.v1"));
    await page.reload();
    await expect(page.getByText("Local runtime")).toBeVisible();
    await page.evaluate(async (path) => {
      await window.zli?.runtime.dispatch({
        protocolVersion: 1,
        commandId: crypto.randomUUID(),
        command: { type: "project.register", path },
      });
    }, shop);
    await expect(project(page, "shop")).toBeVisible();

    await startAgent(page, "repo", "Alpha");
    await startAgent(page, "repo", "Beta");
    await startAgent(page, "shop", "Gamma");
    const tiles = page.locator(".agent-tile");
    await expect(tiles).toHaveCount(3);

    await fromProjectMenu(page, "shop", "Show only this project");
    await expect(tiles).toHaveCount(1);
    await expect(tile(page, "Gamma")).toBeVisible();
    await expect(page.locator(".topbar-project")).toHaveText("shop");

    await fromProjectMenu(page, "repo", "Show only this project");
    await expect(tiles).toHaveCount(2);
    await expect(tile(page, "Alpha")).toBeVisible();
    await expect(tile(page, "Beta")).toBeVisible();
    await expect(page.locator(".topbar-project")).toHaveText("repo");

    await fromProjectMenu(page, "repo", "Close all agents");
    await expect(tiles).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "Close agent" })).toHaveCount(0);

    await page.reload();
    await expect(page.getByText("Local runtime")).toBeVisible();
    await expect(project(page, "shop")).toBeVisible();
    await expect(tiles).toHaveCount(0);
    await fromProjectMenu(page, "repo", "Show only this project");
    await expect(tiles).toHaveCount(2);
    await expect(tile(page, "Gamma")).toHaveCount(0);

    // Opening one of the other project's agents and pressing the shortcut swaps to that project.
    await project(page, "shop")
      .getByRole("button", { name: /^Gamma, / })
      .click();
    await expect(tiles).toHaveCount(3);
    await page.keyboard.press(`${mod}+Shift+P`);
    await expect(tiles).toHaveCount(1);
    await expect(tile(page, "Gamma")).toBeVisible();

    const statuses = await page.evaluate(async () =>
      (await window.zli?.runtime.getProjection())?.threads.map((thread) => thread.status),
    );
    expect(statuses).toHaveLength(3);
    expect(statuses?.filter((status) => status === "stopped" || status === "failed")).toEqual([]);
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});

const project = (page: Page, name: string) => page.getByRole("region", { name, exact: true });

const tile = (page: Page, name: string) => page.getByRole("region", { name: new RegExp(`^${name},`, "u") });

async function startAgent(page: Page, projectName: string, name: string): Promise<void> {
  // A project's row actions show only while the row is hovered.
  await project(page, projectName).locator(".project-label").hover();
  await page.getByRole("button", { name: `New agent in ${projectName}` }).click();
  const dialog = page.getByRole("dialog", { name: "New agent" });
  await dialog.getByText("Codex", { exact: true }).click();
  await dialog.getByText("Chat", { exact: true }).click();
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await dialog.getByRole("button", { name: "Start agent" }).click();
  await expect(page.getByRole("textbox", { name: `Message ${name}` })).toBeEnabled({ timeout: 30_000 });
}

async function fromProjectMenu(page: Page, projectName: string, item: string): Promise<void> {
  await project(page, projectName).locator(".project-label").hover();
  await page.getByRole("button", { name: `${projectName} actions` }).click();
  await page.getByRole("menuitem", { name: item }).click();
}
