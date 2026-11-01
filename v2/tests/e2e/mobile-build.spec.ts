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
const fixture = (name: string) =>
  readFile(join(V2_ROOT, `apps/desktop/src/mobile/dev/build/fixtures/${name}.log`), "utf8");

test("a pasted build log is explained, and its fix is proposed as a card", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  test.setTimeout(120_000);
  const { root, repo } = await createGitFixture();
  let desktop: DesktopFixture | undefined;
  try {
    desktop = await launchDesktop(repo, root, { env: FAKE_MOBILE });
    const { page } = desktop;
    await openWorktree(page, "builds");
    const mobile = await openMobilePanel(page);
    await mobile.getByRole("button", { name: "Project check" }).click();
    const group = mobile.getByRole("region", { name: "Build failure" });
    const log = group.getByLabel("Build log");
    await expect(group.getByRole("button", { name: "Explain" })).toBeDisabled();

    await log.fill(await fixture("gradle-unsupported-class-version"));
    await group.getByRole("button", { name: "Explain" }).click();
    await expect(group.locator(".badge").first()).toHaveText("JDK / Gradle");
    await expect(group).toContainText("General error during conversion: Unsupported class file major version 65");
    await expect(group).toContainText("Install JDK 17 and point JAVA_HOME to it.");
    await expect(group.getByRole("button", { name: "Propose fix" })).toHaveCount(0);

    await log.fill(await fixture("eas-pods-incompatible"));
    await group.getByRole("button", { name: "Explain" }).click();
    await expect(group.locator(".badge").first()).toHaveText("CocoaPods");
    await group.getByRole("button", { name: "Propose fix" }).click();
    const card = mobile.getByRole("article", { name: "Install pods" });
    await expect(card).toContainText("pod install --repo-update");
    await expect(card).toContainText("Runs in ios in a new terminal.");
    await expect(card.getByRole("button", { name: "Run in terminal" })).toBeVisible();
  } finally {
    if (desktop) await closeDesktop(desktop);
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
