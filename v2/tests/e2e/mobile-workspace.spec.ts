import { expect, type Page, test } from "@playwright/test";

import {
  closeDesktop,
  createGitFixture,
  type DesktopFixture,
  launchDesktop,
  openCreateWorktree,
} from "./desktop-fixtures.js";

/** The Mobile panel's own tests run on the fake mobile service: one online Android emulator and scripted probes. */
const FAKE_MOBILE = { ZLI_TEST_MOBILE: "fake" };

test("each worktree gets its own Metro port, in its terminals too, and a port held elsewhere is flagged", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  test.skip(process.platform === "win32", "The terminal check uses POSIX shell syntax.");
  test.setTimeout(120_000);
  const { root, repo } = await createGitFixture();
  let fixture: DesktopFixture | undefined;
  try {
    fixture = await launchDesktop(repo, root, { env: FAKE_MOBILE });
    const { page } = fixture;
    const worktreeId = await openWorktree(page, "cart");
    const mobile = await openMobilePanel(page);

    await mobile.getByRole("button", { name: "Project check" }).click();
    const group = mobile.getByRole("region", { name: "This worktree" });
    await expect(group).toContainText("Set as RCT_METRO_PORT in this worktree's terminals.", { timeout: 20_000 });
    const portText = await group.locator(".settings-value.is-mono").first().textContent();
    const port = Number(portText);
    expect(port).toBeGreaterThanOrEqual(8100);
    expect(port).toBeLessThanOrEqual(8199);
    await expect(group).toContainText(`exp://localhost:${port}`);
    await expect(group).toContainText("Free");

    await mobileTest(page, "metro-owner", {
      worktreeId,
      owner: { state: "other-worktree", pid: 4242, worktreeId: "other", branch: "feat-login" },
    });
    await expect(mobile).toContainText(
      `Port ${port} is served from feat-login, not this worktree. Opening it would show that branch's app.`,
    );
    await expect(group).toContainText("Used by feat-login");

    const output = await startDrawerShell(page);
    await page.keyboard.type("echo port:$RCT_METRO_PORT:$ZLI_METRO_PORT");
    await page.keyboard.press("Enter");
    await expect(output).toContainText(`port:${port}:${port}`, { timeout: 20_000 });
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell expansion typed into the terminal.
    await page.keyboard.type('echo "token:${ZLI_RUNTIME_TOKEN:-unset}"');
    await page.keyboard.press("Enter");
    // The typed line reads token:${...}, so only the shell's answer contains token:unset.
    await expect(output).toContainText("token:unset", { timeout: 20_000 });
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

/** Starts a shell in the drawer for the selected worktree and focuses it. */
async function startDrawerShell(page: Page) {
  const terminalToggle = page.getByRole("button", { name: "Terminal", exact: true });
  if ((await terminalToggle.getAttribute("aria-pressed")) !== "true") await terminalToggle.click();
  await page.getByRole("button", { name: "Start terminal" }).click();
  const output = page.getByRole("log", { name: "Terminal output" });
  await expect(output).toHaveText(/[$>#%]\s*$/u, { timeout: 20_000 });
  await page.locator(".terminal-output .xterm-helper-textarea").focus();
  return output;
}
