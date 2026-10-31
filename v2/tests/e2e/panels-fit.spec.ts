import { writeFile } from "node:fs/promises";

import { type ElectronApplication, expect, type Page, test } from "@playwright/test";

import {
  closeDesktop,
  createGitFixture,
  type DesktopFixture,
  launchDesktop,
  openCreateWorktree,
} from "./desktop-fixtures.js";

test("shrinks the side panel and terminal drawer to fit a smaller window", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  const { root, repo } = await createGitFixture();
  let fixture: DesktopFixture | undefined;
  try {
    fixture = await launchDesktop(repo, root);
    const { app, page } = fixture;
    await expect(page.locator(".project-label")).toContainText("repo");
    // Zooming in shrinks the page further than the window's minimum size does, so allow a small window here.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setMinimumSize(640, 480));
    await resize(app, page, 1440, 900);

    await openCreateWorktree(page);
    const dialog = page.getByRole("dialog", { name: "Create worktree" });
    await dialog.getByLabel("Branch").fill("fit");
    await dialog.getByRole("button", { name: "Create worktree" }).click();
    const worktree = page.getByRole("button", { name: /fit/iu }).first();
    await expect(worktree).toContainText("Ready", { timeout: 30_000 });
    await worktree.click();
    await page.locator(".sidebar-new-agent").click();
    const newAgent = page.getByRole("dialog", { name: "New agent" });
    await newAgent.getByText("Codex", { exact: true }).click();
    await newAgent.getByText("Chat", { exact: true }).click();
    await newAgent.getByRole("button", { name: "Start agent" }).click();
    await expect(page.getByRole("textbox", { name: "Message Codex" })).toBeEnabled({ timeout: 20_000 });

    const terminalToggle = page.getByRole("button", { name: "Terminal", exact: true });
    if ((await terminalToggle.getAttribute("aria-pressed")) !== "true") await terminalToggle.click();
    await page.getByRole("button", { name: "Start terminal" }).click();
    const drawerHandle = page.getByRole("separator", { name: "Resize terminal drawer" });
    await expect(drawerHandle).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "Files", exact: true }).click();
    const panelHandle = page.getByRole("separator", { name: "Resize side panel" });
    await expect(page.getByRole("complementary", { name: "Files panel" })).toBeVisible();

    await drag(page, panelHandle, { x: 0 });
    await drag(page, drawerHandle, { y: 0 });
    const wide = await layout(page);
    await capture(app, "max-1440.png");
    expect(wide.panel.width).toBeGreaterThan(800);
    expect(wide.drawer.height).toBeGreaterThan(500);
    expectFits(wide);

    await resize(app, page, 1000, 560);
    await settle(page);
    await capture(app, "shrunk-1000x560.png");
    expectFits(await layout(page));

    // The size the person chose comes back once the window has room for it again.
    await resize(app, page, 1440, 900);
    await expect.poll(async () => (await layout(page)).panel.width, { timeout: 5_000 }).toBe(wide.panel.width);
    expect((await layout(page)).drawer.height).toBe(wide.drawer.height);
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});

type Box = { left: number; top: number; right: number; bottom: number; width: number; height: number };
type Layout = { window: { width: number; height: number }; grid: Box; panel: Box; drawer: Box };

function expectFits(current: Layout): void {
  const detail = JSON.stringify(current);
  expect.soft(current.grid.width, detail).toBeGreaterThanOrEqual(320);
  expect.soft(current.grid.height, detail).toBeGreaterThanOrEqual(160);
  expect.soft(current.drawer.width, detail).toBeGreaterThanOrEqual(320);
  expect.soft(current.panel.right, detail).toBeLessThanOrEqual(current.window.width);
  expect.soft(current.panel.bottom, detail).toBeLessThanOrEqual(current.window.height);
  expect.soft(current.drawer.bottom, detail).toBeLessThanOrEqual(current.window.height);
  // The drawer sits under the grid and beside the panel, never across either.
  expect.soft(current.drawer.top, detail).toBeGreaterThanOrEqual(current.grid.bottom);
  expect.soft(current.drawer.right, detail).toBeLessThanOrEqual(current.panel.left);
}

async function layout(page: Page): Promise<Layout> {
  return page.evaluate(() => {
    const box = (selector: string) => {
      const rect = document.querySelector(selector)?.getBoundingClientRect();
      if (!rect) throw new Error(`${selector} is not on the page.`);
      const { left, top, right, bottom, width, height } = rect;
      return { left, top, right, bottom, width, height };
    };
    return {
      window: { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight },
      grid: box('section[aria-label="Agents"]'),
      panel: box('aside[aria-label="Files panel"]'),
      drawer: box('section[aria-label="Terminal panel"]'),
    };
  });
}

async function drag(page: Page, handle: ReturnType<Page["locator"]>, to: { x?: number; y?: number }): Promise<void> {
  const box = await handle.boundingBox();
  if (!box) throw new Error("The resize handle is not visible.");
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(to.x ?? start.x, to.y ?? start.y, { steps: 8 });
  await page.mouse.up();
}

async function resize(app: ElectronApplication, page: Page, width: number, height: number): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, [width, height]) => BrowserWindow.getAllWindows()[0]?.setContentSize(width, height),
    [width, height],
  );
  // A window as large as the screen can come out a pixel short of it.
  await expect
    .poll(() =>
      page.evaluate(
        ([width, height]) => Math.max(Math.abs(window.innerWidth - width), Math.abs(window.innerHeight - height)),
        [width, height],
      ),
    )
    .toBeLessThanOrEqual(2);
}

/** Waits for the frame after the next one, by which point a resize has been measured and laid out. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
}

async function capture(app: ElectronApplication, name: string): Promise<void> {
  const png = await app.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0]?.webContents.capturePage())?.toPNG().toString("base64"),
  );
  if (png) await writeFile(test.info().outputPath(name), Buffer.from(png, "base64"));
}
