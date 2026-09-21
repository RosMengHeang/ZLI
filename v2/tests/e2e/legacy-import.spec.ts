import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { closeDesktop, createGitFixture, launchDesktop, type DesktopFixture } from "./desktop-fixtures.js";

test("previews and completes a legacy snapshot import through the desktop UI", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  const { root, repo } = await createGitFixture();
  const snapshotPath = join(root, "legacy-snapshot.json");
  await writeFile(snapshotPath, JSON.stringify({
    format: "zli-legacy-snapshot",
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    workspaceRegistry: {
      workspaces: [{
        root: repo,
        project: { name: "Imported fixture", path: repo, repositoryRoot: repo },
      }],
    },
  }), "utf8");

  let fixture: DesktopFixture | undefined;
  try {
    fixture = await launchDesktop(repo, root, { legacySnapshotPath: snapshotPath });
    await fixture.page.keyboard.press("Control+k");
    await fixture.page.getByRole("button", { name: "Import legacy snapshot" }).click();
    const dialog = fixture.page.getByRole("dialog", { name: "Import legacy workspace" });
    await expect(dialog.getByText("1 projects · 0 worktrees · 0 sessions")).toBeVisible({ timeout: 20_000 });
    await dialog.getByRole("button", { name: "Import selected" }).click();
    await expect(dialog.getByRole("button", { name: "Rollback this batch" })).toBeVisible({ timeout: 20_000 });
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});
