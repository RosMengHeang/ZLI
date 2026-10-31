import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import {
  closeDesktop,
  createGitFixture,
  type DesktopFixture,
  launchDesktop,
  openCreateWorktree,
} from "./desktop-fixtures.js";

test("keeps the runtime token out of the processes the runtime starts", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  const { root, repo } = await createGitFixture();
  // Git runs this hook while the runtime creates a worktree, with the environment the runtime gave it.
  const envDump = join(root, "hook-env.txt");
  const hook = join(repo, ".git", "hooks", "post-checkout");
  await writeFile(hook, `#!/bin/sh\nenv > '${envDump.replaceAll("\\", "/")}'\n`, "utf8");
  await chmod(hook, 0o755);
  let fixture: DesktopFixture | undefined;
  try {
    fixture = await launchDesktop(repo, root);
    const page = fixture.page;
    await openCreateWorktree(page);
    const dialog = page.getByRole("dialog", { name: "Create worktree" });
    await dialog.getByLabel("Branch").fill("hook-env");
    await dialog.getByRole("button", { name: "Create worktree" }).click();
    await expect(page.getByRole("button", { name: /hook-env/iu })).toContainText("Ready", { timeout: 30_000 });

    const names = (await readFile(envDump, "utf8")).split(/\r?\n/u).map((line) => line.split("=", 1)[0]);
    // Shows the hook saw the runtime's own environment, so a missing token is not a missing dump.
    expect(names).toContain("ZLI_DATABASE_PATH");
    expect(names).not.toContain("ZLI_RUNTIME_TOKEN");
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});
