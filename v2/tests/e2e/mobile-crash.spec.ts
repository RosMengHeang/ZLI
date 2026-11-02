import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, type Page, test } from "@playwright/test";

import {
  closeDesktop,
  createGitFixture,
  type DesktopFixture,
  launchDesktop,
  openCreateWorktree,
  V2_ROOT,
} from "./desktop-fixtures.js";

const FAKE_MOBILE = { ZLI_TEST_MOBILE: "fake" };
const FIXTURE = join(V2_ROOT, "apps/desktop/src/mobile/dev/crash/fixtures/java-fatal.log");

test("a crash in the device log shows as a banner with its stack, and Dismiss hides it", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  test.setTimeout(120_000);
  const { root, repo } = await createGitFixture();
  let fixture: DesktopFixture | undefined;
  try {
    fixture = await launchDesktop(repo, root, { env: FAKE_MOBILE });
    const { page } = fixture;
    await openWorktree(page, "crashes");
    const mobile = await openMobilePanel(page);
    const lines = (await readFile(FIXTURE, "utf8")).split("\n");

    await mobileTest(page, "emit-log", { lines: lines.slice(0, 70) });
    const banner = mobile.getByRole("region", { name: "App crash" });
    await expect(banner).toContainText(
      "com.example.app crashed: IllegalStateException: Fragment ProfileFragment{5f2a1b} not attached to a context.",
    );
    await expect(banner.getByRole("button", { name: "Send to agent" })).toBeDisabled();

    await banner.getByRole("button", { name: "Show details" }).click();
    await expect(banner.locator("pre")).toContainText(
      "at com.example.app.profile.ProfileFragment.onAvatarLoaded(ProfileFragment.kt:88)",
    );

    await mobileTest(page, "emit-log", { lines: lines.slice(70) });
    await expect(banner).toContainText("×2");

    await banner.getByRole("button", { name: "Dismiss crash" }).click();
    await expect(banner).toHaveCount(0);
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});
async function openWorktree(page: Page, branch: string): Promise<string> {
  await openCreateWorktree(page);
  const dialog = page.getByRole("dialog", { name: "Create worktree" });
  await dialog.getByLabel("Branch").fill(branch);
  await dialog.getByRole("button", { name: "Create worktree" }).click();
  const worktree = page.getByRole("button", { name: new RegExp(branch, "iu") }).first();
  await expect(worktree).toContainText("Ready", { timeout: 30_000 });
  await worktree.click();
  const worktreeId = await page.evaluate(
    async (name) =>
      (await window.zli?.runtime.getProjection())?.worktrees.find((entry) => entry.branch === name)?.worktreeId,
    branch,
  );
  if (!worktreeId) throw new Error(`The ${branch} worktree is not in the projection.`);
  return worktreeId;
}

async function openMobilePanel(page: Page) {
  await page.keyboard.press("ControlOrMeta+Shift+M");
  const mobile = page.getByRole("complementary", { name: "Mobile panel" });
  await expect(mobile).toContainText("Pixel_Test", { timeout: 30_000 });
  return mobile;
}
async function mobileTest(page: Page, op: string, input: unknown): Promise<unknown> {
  return page.evaluate(([name, value]) => window.zli?.test?.mobile?.(name as string, value), [op, input] as const);
}
