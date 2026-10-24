import { access } from "node:fs/promises";
import { join } from "node:path";

import { expect, type Page, test } from "@playwright/test";

import {
  closeDesktop,
  createGitFixture,
  type DesktopFixture,
  git,
  launchDesktop,
  sendChatMessage,
} from "./desktop-fixtures.js";

type WorktreeInfo = { worktreeId: string; branch: string; path: string; kind?: string };

async function worktrees(page: Page): Promise<WorktreeInfo[]> {
  return page.evaluate(async () => {
    const projection = await window.zli?.runtime.getProjection();
    return (projection?.worktrees ?? []).map(({ worktreeId, branch, path, kind }) => ({
      worktreeId,
      branch,
      path,
      kind,
    }));
  });
}

async function runWorktrees(page: Page): Promise<WorktreeInfo[]> {
  return (await worktrees(page)).filter((worktree) => /-run\d$/u.test(worktree.branch));
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

async function startChat(page: Page): Promise<void> {
  await expect(page.locator(".project-label")).toContainText("repo");
  await page.locator(".sidebar-new-agent").click();
  const newAgent = page.getByRole("dialog", { name: "New agent" });
  await newAgent.getByText("Codex", { exact: true }).click();
  await newAgent.getByText("Chat", { exact: true }).click();
  await newAgent.getByRole("button", { name: "Start agent" }).click();
}

test("sends a message as Best of N, compares the runs, and keeps one", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  const { root, repo } = await createGitFixture();
  let fixture: DesktopFixture | undefined;
  try {
    fixture = await launchDesktop(repo, root);
    const page = fixture.page;
    await startChat(page);

    const composer = page.getByRole("textbox", { name: "Message Codex" });
    await expect(composer).toBeEnabled({ timeout: 30_000 });
    await composer.fill("[write plan.md] sketch a plan");
    await page.getByRole("button", { name: "More ways to send" }).click();
    await page.getByRole("menuitem", { name: /Send as Best of N/u }).click();
    const popover = page.getByRole("dialog", { name: "Send as Best of N" });
    await expect(popover).toContainText("Creates 3 worktrees from the current state");
    await popover.getByRole("button", { name: "2 runs" }).click();
    await expect(popover).toContainText("Creates 2 worktrees from the current state");
    await popover.getByRole("button", { name: "Start runs" }).click();
    await expect(popover).toBeHidden();

    await expect.poll(async () => (await runWorktrees(page)).length, { timeout: 30_000 }).toBe(2);
    const group = page.getByRole("group", { name: /^Best of 2 from / });
    await expect(group.getByRole("button", { name: /^Run 1, Codex, / })).toBeVisible();
    await expect(group.getByRole("button", { name: "Compare" })).toBeVisible({ timeout: 60_000 });
    await expect(group.getByRole("button", { name: "Run 1, Codex, Done" })).toBeVisible();
    await expect(group.getByRole("button", { name: "Run 2, Codex, Done" })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "All 2 runs for" })).toBeVisible();

    await group.getByRole("button", { name: "Compare" }).click();
    const compare = page.getByRole("dialog", { name: "Compare runs" });
    const first = compare.getByRole("listitem", { name: "Run 1" });
    const second = compare.getByRole("listitem", { name: "Run 2" });
    for (const column of [first, second]) {
      await expect(column).toContainText("Codex");
      await expect(column).toContainText("Done");
      await expect(column).toContainText("1 file");
      await expect(column.getByRole("button", { name: "View diff" })).toBeEnabled();
    }

    const runs = await runWorktrees(page);
    const kept = runs.find((worktree) => worktree.branch.endsWith("-run2"));
    const dropped = runs.find((worktree) => worktree.branch.endsWith("-run1"));
    if (!kept || !dropped) throw new Error("Both run worktrees should exist.");
    expect(await exists(join(kept.path, "plan.md"))).toBe(true);

    await second.getByRole("button", { name: "Keep this one" }).click();
    const confirm = page.getByRole("dialog", { name: "Keep this run" });
    await expect(confirm).toContainText(dropped.branch);
    await confirm.getByRole("button", { name: "Keep this one" }).click();
    await expect(confirm).toBeHidden();

    await expect
      .poll(async () => (await runWorktrees(page)).map((worktree) => worktree.branch), { timeout: 30_000 })
      .toEqual([kept.branch]);
    await expect.poll(() => exists(dropped.path), { timeout: 20_000 }).toBe(false);
    await expect.poll(() => git(repo, ["branch", "--list", dropped.branch]), { timeout: 20_000 }).toBe("");
    expect(await git(repo, ["branch", "--list", kept.branch])).toContain(kept.branch);
    await expect(page.getByRole("group", { name: /^Best of 2 from / })).toHaveCount(0);
    await expect(page.locator(".agent-tile .tile-run")).toHaveCount(0);
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});

test("tries an earlier message several ways, starting from before it was sent", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  const { root, repo } = await createGitFixture();
  let fixture: DesktopFixture | undefined;
  try {
    fixture = await launchDesktop(repo, root);
    const page = fixture.page;
    await startChat(page);
    await sendChatMessage(page, "[write notes.md] first change");
    await expect(page.getByText("Mock response: [write notes.md] first change")).toBeVisible({ timeout: 30_000 });
    await sendChatMessage(page, "[write other.md] second change");
    await expect(page.getByText("Mock response: [write other.md] second change")).toBeVisible({ timeout: 30_000 });
    // Each turn's changes are saved just after it ends; until then Try N ways cannot know where to start.
    await expect(page.getByRole("region", { name: "Changes in this turn" })).toHaveCount(2, { timeout: 20_000 });

    const message = page.locator(".chat-message-user").filter({ hasText: "[write notes.md] first change" });
    await message.hover();
    await message.getByRole("button", { name: "Try N ways" }).click();
    const popover = page.getByRole("dialog", { name: "Try N ways" });
    await expect(popover).toContainText("[write notes.md] first change");
    await expect(popover).toContainText("from the state before this message");
    await popover.getByRole("button", { name: "2 runs" }).click();
    await popover.getByRole("button", { name: "Start runs" }).click();
    await expect(popover).toBeHidden();

    const group = page.getByRole("group", { name: /^Best of 2 from / });
    await expect(group.getByRole("button", { name: "Compare" })).toBeVisible({ timeout: 60_000 });
    const runs = await runWorktrees(page);
    expect(runs).toHaveLength(2);
    for (const run of runs) {
      // The run started before the first message, so the second turn's file is not there.
      expect(await exists(join(run.path, "notes.md"))).toBe(true);
      expect(await exists(join(run.path, "other.md"))).toBe(false);
    }
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});
