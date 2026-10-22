import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, type Page, test } from "@playwright/test";

import { closeDesktop, createGitFixture, git, launchDesktop, type DesktopFixture } from "./desktop-fixtures.js";

async function createWorktree(page: Page, branch: string) {
  await page.getByRole("button", { name: "Create worktree", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create worktree" });
  await dialog.getByLabel("Branch").fill(branch);
  await dialog.getByRole("button", { name: "Create worktree" }).click();
  return page.locator(".worktree-row", { hasText: branch });
}

test("copies zli.json files and runs setup only after the person trusts it", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  const { root, repo } = await createGitFixture();
  await writeFile(join(repo, ".gitignore"), ".env\n", "utf8");
  await git(repo, ["add", ".gitignore"]);
  await git(repo, ["commit", "-m", "ignore env"]);
  await writeFile(join(repo, ".env"), "API_KEY=from-main\n", "utf8");
  await writeFile(
    join(repo, "zli.json"),
    JSON.stringify({ version: 1, worktree: { copy: [".env"], setup: ["echo setup-ran > setup-done.txt"] } }),
    "utf8",
  );
  let fixture: DesktopFixture | undefined;
  try {
    fixture = await launchDesktop(repo, root);
    const page = fixture.page;

    const first = await createWorktree(page, "setup-first");
    const approval = page.getByRole("dialog", { name: "Approve setup commands" });
    await expect(approval).toBeVisible({ timeout: 30_000 });
    await expect(approval.getByRole("list", { name: "Setup commands" })).toHaveText("echo setup-ran > setup-done.txt");
    await expect(approval).toContainText("Copied from the main checkout: .env.");
    await expect(first).toContainText("Needs approval");
    const firstPath = join(`${repo}-worktrees`, "setup-first");
    await expect(access(join(firstPath, "setup-done.txt"))).rejects.toThrow();

    await approval.getByRole("button", { name: "Always run for this project" }).click();
    await expect(approval).toHaveCount(0);
    await expect(first).toContainText("Ready", { timeout: 30_000 });
    await expect.poll(() => readFile(join(firstPath, "setup-done.txt"), "utf8").catch(() => "")).toContain("setup-ran");
    await expect(readFile(join(firstPath, ".env"), "utf8")).resolves.toBe("API_KEY=from-main\n");
    const setupTerminal = await page.evaluate(async () => {
      const projection = await window.zli?.runtime.getProjection();
      return projection?.terminals.find((terminal) => terminal.title === "Setup")?.status;
    });
    expect(setupTerminal).toBe("exited");

    // The same commands are trusted now, so the next worktree runs them without asking.
    const second = await createWorktree(page, "setup-second");
    await expect(second).toContainText("Ready", { timeout: 30_000 });
    await expect(page.getByRole("dialog", { name: "Approve setup commands" })).toHaveCount(0);
    const secondPath = join(`${repo}-worktrees`, "setup-second");
    await expect
      .poll(() => readFile(join(secondPath, "setup-done.txt"), "utf8").catch(() => ""))
      .toContain("setup-ran");

    // A broken zli.json never blocks the worktree; it is reported instead.
    await writeFile(join(repo, "zli.json"), JSON.stringify({ version: 1, worktree: { copy: ["../outside"] } }), "utf8");
    const third = await createWorktree(page, "setup-third");
    await expect(third).toContainText("zli.json error", { timeout: 30_000 });
    await expect(page.getByRole("alert")).toContainText("worktree.copy.0");
    await expect(access(join(`${repo}-worktrees`, "setup-third", ".env"))).rejects.toThrow();
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});
