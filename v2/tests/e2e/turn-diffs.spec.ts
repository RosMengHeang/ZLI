import { access } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import {
  closeDesktop,
  createGitFixture,
  type DesktopFixture,
  launchDesktop,
  sendChatMessage,
} from "./desktop-fixtures.js";

test("shows the files a turn changed with their diff and restores them", async () => {
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
    await newAgent.getByRole("button", { name: "Start agent" }).click();
    await sendChatMessage(page, "[write notes.md] add release notes");
    await expect(page.getByText("Mock response: [write notes.md] add release notes")).toBeVisible({ timeout: 30_000 });

    const worktreePath = await page.evaluate(async () => {
      const projection = await window.zli?.runtime.getProjection();
      const thread = projection?.threads[0];
      return projection?.worktrees.find((worktree) => worktree.worktreeId === thread?.worktreeId)?.path ?? "";
    });
    expect(worktreePath).not.toBe("");
    await expect(access(join(worktreePath, "notes.md"))).resolves.toBeUndefined();

    const changes = page.getByRole("region", { name: "Changes in this turn" });
    await expect(changes).toContainText("1 file changed", { timeout: 20_000 });
    await changes.getByRole("button", { name: /notes\.md/u }).click();
    await expect(changes.getByRole("region", { name: "Diff for notes.md" })).toContainText(
      "+Written by the mock agent: [write notes.md] add release notes",
    );

    await changes.getByRole("button", { name: "Restore", exact: true }).click();
    const confirm = page.getByRole("dialog", { name: "Restore files" });
    await expect(confirm).toContainText("This turn changed 1 file.");
    await confirm.getByRole("button", { name: "Restore files" }).click();
    await expect(
      page.getByText("Restored 1 file to how they were before an earlier turn.", { exact: false }),
    ).toBeVisible({
      timeout: 20_000,
    });
    await expect
      .poll(() =>
        access(join(worktreePath, "notes.md")).then(
          () => "present",
          () => "gone",
        ),
      )
      .toBe("gone");
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});
