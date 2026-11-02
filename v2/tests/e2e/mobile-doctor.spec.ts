import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, type Page, test } from "@playwright/test";

import {
  closeDesktop,
  createGitFixture,
  type DesktopFixture,
  launchDesktop,
  openCreateWorktree,
} from "./desktop-fixtures.js";

/** The fake mobile service scripts every probe and network answer, so the project check never runs real tools. */
const FAKE_MOBILE = { ZLI_TEST_MOBILE: "fake" };

/** An Expo SDK 55 app that still sets newArchEnabled: false, which SDK 55 no longer allows. */
const EXPO_55_APP = {
  "package.json": JSON.stringify(
    { name: "legacy", version: "1.0.0", dependencies: { expo: "~55.0.0", react: "19.1.0", "react-native": "0.83.1" } },
    null,
    2,
  ),
  "app.json": JSON.stringify({ expo: { name: "Legacy", slug: "legacy", newArchEnabled: false } }, null, 2),
};

test("the project check finds a removed New Architecture opt-out and writes agent notes only after Write", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  test.setTimeout(120_000);
  const { root, repo } = await createGitFixture();
  let fixture: DesktopFixture | undefined;
  try {
    fixture = await launchDesktop(repo, root, { env: FAKE_MOBILE });
    const { page } = fixture;
    await openWorktree(page, "legacy");
    const folder = join(`${repo}-worktrees`, "legacy");
    await writeApp(folder);
    const mobile = await openMobilePanel(page);
    await mobile.getByRole("button", { name: "Project check" }).click();

    const toolchain = mobile.getByRole("region", { name: "Toolchain" });
    await expect(toolchain).toContainText("newArchEnabled is false in app.json", { timeout: 20_000 });
    await expect(toolchain).toContainText("SDK 55 and later cannot turn off the New Architecture");
    await expect(toolchain.getByRole("list", { name: "Versions" })).toContainText("55.0.0");

    await toolchain.getByRole("button", { name: "Prepare notes" }).click();
    const card = mobile.getByRole("article", { name: "Add mobile notes for agents" });
    await expect(card).toContainText("Expo SDK 55");
    await expect(readFile(join(folder, "AGENTS.md"), "utf8")).rejects.toThrow();

    await card.getByRole("button", { name: "Write to AGENTS.md" }).click();
    await expect(card).toHaveCount(0);
    await expect
      .poll(() => readFile(join(folder, "AGENTS.md"), "utf8").catch(() => ""))
      .toContain("<!-- zli:mobile:start -->");
    const written = await readFile(join(folder, "AGENTS.md"), "utf8");
    expect(written).toContain("<!-- zli:mobile:end -->");
    expect(written).toContain("Do not set newArchEnabled=false");

    await expect(toolchain.getByText("Up to date")).toBeVisible({ timeout: 20_000 });
    await toolchain.getByRole("button", { name: "Prepare notes" }).click();
    await expect(toolchain.getByText("Up to date")).toBeVisible();
    await expect(mobile.getByRole("article", { name: "Add mobile notes for agents" })).toHaveCount(0);
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});

test("a package check warns about an unmaintained package and proposes the install without running it", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  test.setTimeout(120_000);
  const { root, repo } = await createGitFixture();
  let fixture: DesktopFixture | undefined;
  try {
    fixture = await launchDesktop(repo, root, { env: FAKE_MOBILE });
    const { page } = fixture;
    await openWorktree(page, "packages");
    await writeApp(join(`${repo}-worktrees`, "packages"));
    await mobileTest(page, "fetch-answer", {
      url: "https://reactnative.directory/api/libraries/check?packages=react-native-fs",
      status: 200,
      json: { "react-native-fs": { unmaintained: true } },
    });
    await mobileTest(page, "fetch-answer", {
      url: "https://reactnative.directory/api/library?name=react-native-fs",
      status: 200,
      json: { "react-native-fs": { github: { isArchived: false }, npm: { latestRelease: "2.20.0" } } },
    });
    const mobile = await openMobilePanel(page);
    await mobile.getByRole("button", { name: "Project check" }).click();

    const group = mobile.getByRole("region", { name: "Packages" });
    await group.getByLabel("Check packages").fill("react-native-fs");
    await group.getByRole("button", { name: "Check", exact: true }).click();
    const results = group.getByRole("list", { name: "Package results" });
    await expect(results).toContainText("Warning", { timeout: 20_000 });
    await expect(results).toContainText("React Native Directory marks it unmaintained");
    await expect(group).toContainText("npx expo install react-native-fs");

    await group.getByRole("button", { name: "Propose install" }).click();
    const card = mobile.getByRole("article", { name: "Install react-native-fs" });
    await expect(card).toContainText("npx expo install react-native-fs");
    await expect(card).toContainText("From the project check");
    expect(await terminals(page)).toEqual([]);
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});

async function writeApp(folder: string) {
  await mkdir(folder, { recursive: true });
  for (const [name, text] of Object.entries(EXPO_55_APP)) await writeFile(join(folder, name), `${text}\n`);
}

// Copied from mobile.spec.ts.
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
