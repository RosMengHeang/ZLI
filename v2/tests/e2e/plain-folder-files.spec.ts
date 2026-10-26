import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { closeDesktop, type DesktopFixture, launchDesktop } from "./desktop-fixtures.js";

test("shows a folder without Git in Files and opens it in another app", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  const root = await mkdtemp(join(tmpdir(), "zli-v2-e2e-"));
  const folder = join(root, "plain");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "notes.md"), "# Plain folder\n", "utf8");
  let fixture: DesktopFixture | undefined;
  try {
    fixture = await launchDesktop(folder, root);
    const page = fixture.page;
    await page.getByRole("button", { name: "Files", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "Files panel" });
    await expect(panel.getByText("Pick a project folder")).toBeVisible({ timeout: 10_000 });
    await panel.getByRole("button", { name: "Show plain", exact: true }).click();
    await expect(panel.locator(".file-row", { hasText: "notes.md" })).toBeVisible({ timeout: 10_000 });

    await page.evaluate(() => window.localStorage.removeItem("zli.openIn.v1"));
    await panel.getByRole("button", { name: "Open in another app" }).click();
    const menu = page.getByRole("menu", { name: "Open in" });
    const fileManager =
      process.platform === "darwin" ? "Finder" : process.platform === "win32" ? "File Explorer" : "Files";
    await menu.getByRole("menuitem", { name: fileManager }).click();
    await expect
      .poll(() => page.evaluate(() => window.zli?.test?.takeOpenIn?.()))
      .toEqual({ appId: "files", path: folder });
    // The app picked last becomes the main button.
    await expect(panel.getByRole("button", { name: `Open in ${fileManager}` })).toBeVisible();
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});
