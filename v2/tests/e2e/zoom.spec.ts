import { writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";

import { type ElectronApplication, expect, type Page, test } from "@playwright/test";

import {
  closeDesktop,
  createGitFixture,
  type DesktopFixture,
  launchDesktop,
  openCreateWorktree,
} from "./desktop-fixtures.js";

test("zooms the app between 50% and 300% without the layout scrolling sideways", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  const { root, repo } = await createGitFixture();
  let fixture: DesktopFixture | undefined;
  try {
    fixture = await launchDesktop(repo, root);
    const { app, page } = fixture;
    await expect(page.locator(".project-label")).toContainText("repo");
    const zoom = () =>
      app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor() ?? 0);

    // Chromium remembers zoom per origin across launches, so start from actual size.
    await press(app, "0");
    await expect.poll(zoom).toBe(1);
    await press(app, "=");
    await expect.poll(zoom).toBeCloseTo(1.1, 3);
    for (const factor of [1.25, 1.5, 1.75, 2, 2.5, 3, 3]) {
      await press(app, "=");
      await expect.poll(zoom).toBeCloseTo(factor, 3);
      await capture(app, `zoom-${Math.round(factor * 100)}.png`);
      await expectNoSidewaysScroll(page);
    }

    // Too narrow for the sidebar beside the work, so it steps aside and still opens on request.
    await expect(page.locator(".sidebar")).toBeHidden();
    await page.getByRole("button", { name: "Show sidebar" }).click();
    await expect(page.locator(".sidebar")).toBeVisible();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+B" : "Control+B");
    await expect(page.locator(".sidebar")).toBeHidden();

    // The smallest window at 300% leaves 320 CSS pixels.
    await resize(app, 960, 640);
    await expect.poll(() => page.evaluate(() => document.documentElement.clientWidth)).toBeLessThanOrEqual(320);
    await capture(app, "zoom-300-small.png");
    await expectNoSidewaysScroll(page);
    await resize(app, 1440, 900);

    await press(app, "0");
    await expect.poll(zoom).toBe(1);
    for (const factor of [0.9, 0.8, 0.75, 0.67, 0.5, 0.5]) {
      await press(app, "-");
      await expect.poll(zoom).toBeCloseTo(factor, 3);
      await expectNoSidewaysScroll(page);
    }
    await capture(app, "zoom-50.png");

    await page.keyboard.press(process.platform === "darwin" ? "Meta+K" : "Control+K");
    await page.getByRole("textbox", { name: "Search commands" }).fill("actual size");
    await page.getByRole("button", { name: "Actual size" }).click();
    await expect.poll(zoom).toBe(1);
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});

/** Sends the key through Electron's input path; Playwright's keyboard skips the main process. */
async function press(app: ElectronApplication, keyCode: string): Promise<void> {
  await app.evaluate(({ BrowserWindow }, keyCode) => {
    const modifier = process.platform === "darwin" ? "meta" : "control";
    BrowserWindow.getAllWindows()[0]?.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers: [modifier] });
  }, keyCode);
}

async function resize(app: ElectronApplication, width: number, height: number): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, [width, height]) => BrowserWindow.getAllWindows()[0]?.setSize(width, height),
    [width, height],
  );
}

async function capture(app: ElectronApplication, name: string): Promise<void> {
  const png = await app.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0]?.webContents.capturePage())?.toPNG().toString("base64"),
  );
  if (png) await writeFile(test.info().outputPath(name), Buffer.from(png, "base64"));
}

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const wide = [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((element) => element.getBoundingClientRect().right > width + 1)
      .slice(0, 5)
      .map((element) => `${element.tagName}.${element.className}`);
    return { scroll: document.documentElement.scrollWidth - width, width, wide };
  });
  expect(overflow.scroll, JSON.stringify(overflow)).toBeLessThanOrEqual(0);
}

test("keeps the browser page on its pane when the app is zoomed", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  const { root, repo } = await createGitFixture();
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>ZLI fixture</title><main>zoomed page</main>");
  });
  let fixture: DesktopFixture | undefined;
  try {
    const port = await listen(server);
    fixture = await launchDesktop(repo, root);
    const { app, page } = fixture;
    await expect(page.locator(".project-label")).toContainText("repo");
    await press(app, "0");
    await openCreateWorktree(page);
    const createWorktree = page.getByRole("dialog", { name: "Create worktree" });
    await createWorktree.getByLabel("Branch").fill("zoom");
    await createWorktree.getByRole("button", { name: "Create worktree" }).click();
    const worktree = page.getByRole("button", { name: /zoom/iu }).first();
    await expect(worktree).toContainText("Ready", { timeout: 30_000 });
    await worktree.click();
    await page.locator(".sidebar-new-agent").click();
    const newAgent = page.getByRole("dialog", { name: "New agent" });
    await newAgent.getByText("Codex", { exact: true }).click();
    await newAgent.getByText("Chat", { exact: true }).click();
    await newAgent.getByRole("button", { name: "Start agent" }).click();
    await expect(page.getByRole("textbox", { name: "Message Codex" })).toBeEnabled({ timeout: 20_000 });

    const browserToggle = page.getByRole("button", { name: "Browser", exact: true });
    if (!(await page.getByRole("complementary", { name: "Browser panel" }).isVisible())) await browserToggle.click();
    await page.getByRole("textbox", { name: "Browser URL" }).fill(`http://127.0.0.1:${port}`);
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await expect(page.getByRole("heading", { name: "ZLI fixture" })).toBeVisible({ timeout: 20_000 });

    for (const key of ["=", "=", "-", "-", "-"]) {
      await press(app, key);
      // The native page view is placed in whole window pixels: the pane's CSS box times the zoom, rounded.
      await expect.poll(() => pageOffPane(app, page), { timeout: 5_000 }).toBeLessThanOrEqual(2);
    }
    await capture(app, "browser-zoom-90.png");
  } finally {
    if (fixture) await closeDesktop(fixture);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/** How many window pixels the visible browser view sits away from its pane, on its worst edge. */
async function pageOffPane(app: ElectronApplication, page: Page): Promise<number> {
  const pane = await page.evaluate(() => {
    const rect = document.querySelector(".browser-surface")?.getBoundingClientRect();
    return rect ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height } : undefined;
  });
  const { zoom, view } = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const visible = window?.contentView.children.find((child) => child.getVisible());
    return { zoom: window?.webContents.getZoomFactor() ?? 1, view: visible?.getBounds() };
  });
  if (!pane || !view) return Number.POSITIVE_INFINITY;
  return Math.max(
    Math.abs(view.x - pane.x * zoom),
    Math.abs(view.y - pane.y * zoom),
    Math.abs(view.width - pane.width * zoom),
    Math.abs(view.height - pane.height * zoom),
  );
}

async function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address !== "string") resolve(address.port);
      else reject(new Error("The page server did not bind."));
    });
  });
}
