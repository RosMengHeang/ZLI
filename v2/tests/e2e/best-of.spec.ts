import { access } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { closeDesktop, createGitFixture, git, launchDesktop, type DesktopFixture } from "./desktop-fixtures.js";

test("runs the same task twice in separate worktrees and keeps one", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  const { root, repo } = await createGitFixture();
  let fixture: DesktopFixture | undefined;
  try {
    fixture = await launchDesktop(repo, root);
    const page = fixture.page;
    await expect(page.locator(".project-label")).toContainText("repo");

    await page.locator(".sidebar-new-agent").click();
    const newAgent = page.getByRole("dialog", { name: "New agent" });
    await newAgent.getByText("Codex", { exact: true }).click();
    await newAgent.getByText("Chat", { exact: true }).click();
    await expect(newAgent.getByRole("radio", { name: /New worktree/u })).toBeChecked();
    await newAgent.getByLabel("Branch name").fill("race");
    await newAgent.getByRole("group", { name: "Runs" }).getByRole("button", { name: "2 runs" }).click();
    await expect(newAgent.getByRole("combobox", { name: "Agent for run 2" })).toHaveValue("codex");
    await expect(newAgent).toContainText("Creates branches race-1 to race-2");
    await newAgent.getByLabel("First message").fill("inspect workspace");
    await newAgent.getByRole("button", { name: "Start 2 agents" }).click();
    await expect(newAgent).toHaveCount(0);

    const tileFor = (branch: string) =>
      page.locator(".agent-tile").filter({ has: page.getByPlaceholder(`Ask Codex to change ${branch}`) });
    const first = tileFor("race-1");
    const second = tileFor("race-2");
    await expect(first.locator(".tile-run")).toHaveText("Run 1 of 2");
    await expect(second.locator(".tile-run")).toHaveText("Run 2 of 2");
    // Both runs get the same first message, each in its own worktree.
    await expect(first.getByText("Mock response: inspect workspace")).toBeVisible({ timeout: 30_000 });
    await expect(second.getByText("Mock response: inspect workspace")).toBeVisible({ timeout: 30_000 });
    const paths = await page.evaluate(async () => {
      const projection = await window.zli?.runtime.getProjection();
      return (projection?.worktrees ?? []).map((worktree) => worktree.path.replaceAll("\\", "/"));
    });
    expect(paths.some((path) => path.endsWith("/race-1"))).toBe(true);
    expect(paths.some((path) => path.endsWith("/race-2"))).toBe(true);

    await first.getByRole("button", { name: "Keep this one" }).click();
    const confirm = page.getByRole("dialog", { name: "Keep this run" });
    await expect(confirm).toContainText("Keep run 1 of 2?");
    await expect(confirm.getByRole("list", { name: "Runs to delete" })).toContainText("race-2");
    await confirm.getByRole("button", { name: "Keep this one" }).click();
    await expect(confirm).toHaveCount(0);

    await expect(second).toHaveCount(0, { timeout: 20_000 });
    await expect(page.locator(".agent-tile")).toHaveCount(1);
    await expect(first.locator(".tile-run")).toHaveCount(0);
    await expect(first.getByRole("button", { name: "Keep this one" })).toHaveCount(0);
    const discardedPath = join(`${repo}-worktrees`, "race-2");
    await expect
      .poll(
        () =>
          access(discardedPath).then(
            () => "present",
            () => "gone",
          ),
        { timeout: 20_000 },
      )
      .toBe("gone");
    await expect(access(join(`${repo}-worktrees`, "race-1"))).resolves.toBeUndefined();
    // Discarding a run removes its folder, not its branch.
    expect(await git(repo, ["branch", "--list", "race-2"])).toContain("race-2");
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});
