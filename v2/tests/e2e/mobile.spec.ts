import { readFile } from "node:fs/promises";
import { join } from "node:path";

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

test("a proposed command runs in a terminal only after the person chooses Run", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  test.setTimeout(120_000);
  const { root, repo } = await createGitFixture();
  let fixture: DesktopFixture | undefined;
  try {
    fixture = await launchDesktop(repo, root, { env: FAKE_MOBILE });
    const { page } = fixture;
    const worktreeId = await openWorktree(page, "mobile");
    const mobile = await openMobilePanel(page);

    await mobileTest(page, "propose", { worktreeId, program: "npm", args: ["--version"] });
    const card = mobile.getByRole("article", { name: "Run a command" });
    await expect(card).toContainText("npm --version");
    await expect(card).toContainText("Runs in the worktree folder in a new terminal.");
    expect(await terminals(page)).toEqual([]);

    await card.getByRole("button", { name: "Run in terminal" }).click();
    await expect(card).toContainText("Running in the terminal drawer");
    await expect.poll(() => terminals(page), { timeout: 20_000 }).toEqual([{ title: "Run a command", worktreeId }]);
    await card.getByRole("button", { name: "Open terminal" }).click();
    await expect(page.getByRole("log", { name: "Terminal output" })).toContainText(/\d+\.\d+\.\d+/u, {
      timeout: 30_000,
    });

    await card.getByRole("button", { name: "Dismiss" }).click();
    await expect(card).toHaveCount(0);
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});

test("a proposed file change is written only after the person chooses Write, and Dismiss drops it", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  test.setTimeout(120_000);
  const { root, repo } = await createGitFixture();
  let fixture: DesktopFixture | undefined;
  try {
    fixture = await launchDesktop(repo, root, { env: FAKE_MOBILE });
    const { page } = fixture;
    const worktreeId = await openWorktree(page, "notes");
    const mobile = await openMobilePanel(page);
    const agentsFile = join(`${repo}-worktrees`, "notes", "AGENTS.md");

    await mobileTest(page, "propose", {
      worktreeId,
      title: "Install expo-camera",
      program: "npx",
      args: ["expo", "install", "expo-camera"],
    });
    const command = mobile.getByRole("article", { name: "Install expo-camera" });
    await command.getByRole("button", { name: "Dismiss" }).click();
    await expect(command).toHaveCount(0);
    expect(await terminals(page)).toEqual([]);

    await mobileTest(page, "propose-file", { worktreeId, content: "Run Metro on port 8082." });
    const block = mobile.getByRole("article").filter({ hasText: "Adds these lines to AGENTS.md:" });
    await expect(block).toContainText("Run Metro on port 8082.");
    await expect(readFile(agentsFile, "utf8")).rejects.toThrow();

    await block.getByRole("button", { name: "Write to AGENTS.md" }).click();
    await expect(mobile.getByText("Updated AGENTS.md.")).toBeVisible();
    await expect(block).toHaveCount(0);
    await expect.poll(() => readFile(agentsFile, "utf8")).toContain("Run Metro on port 8082.");
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

async function terminals(page: Page): Promise<{ title: string; worktreeId: string }[]> {
  return page.evaluate(async () =>
    ((await window.zli?.runtime.getProjection())?.terminals ?? []).map(({ title, worktreeId }) => ({
      title,
      worktreeId,
    })),
  );
}
