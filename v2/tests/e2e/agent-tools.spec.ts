import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";

import { closeDesktop, createGitFixture, type DesktopFixture, launchDesktop, V2_ROOT } from "./desktop-fixtures.js";

const execFileAsync = promisify(execFile);

type Agents = { project: string; agents: Array<{ id: string; sameWorktree: boolean; branch: string }> };

test("lets agents list, start, read, and message each other with the zli command", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  const { root, repo } = await createGitFixture();
  let fixture: DesktopFixture | undefined;
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  const zli = async (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    try {
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [join(V2_ROOT, "apps/desktop/dist/zli.js"), ...args],
        {
          env: {
            ...process.env,
            ZLI_BROWSER_CONTROL_FILE: join(root, "runtime.sqlite.browser-control.json"),
            ZLI_WORKTREE_ID: undefined,
          },
          timeout: 120_000,
        },
      );
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failed = error as { code?: number; stdout?: string; stderr?: string };
      return { code: failed.code ?? 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
    }
  };
  try {
    fixture = await launchDesktop(repo, root);
    const { page } = fixture;
    await expect(page.locator(".project-label")).toContainText("repo");

    await page.keyboard.press(`${mod}+n`);
    const dialog = page.getByRole("dialog", { name: "New agent" });
    await dialog.getByText("Codex", { exact: true }).click();
    await dialog.getByText("Chat", { exact: true }).click();
    await dialog.getByRole("button", { name: "Start agent" }).click();
    await expect(page.getByRole("textbox", { name: "Message Codex" })).toBeVisible();
    let firstPath = "";
    await expect
      .poll(
        async () => {
          firstPath = await page.evaluate(async () => {
            const projection = await window.zli?.runtime.getProjection();
            const thread = projection?.threads.find((candidate) => candidate.status === "idle");
            return projection?.worktrees.find((worktree) => worktree.worktreeId === thread?.worktreeId)?.path ?? "";
          });
          return firstPath;
        },
        { timeout: 20_000 },
      )
      .not.toBe("");

    const listed = await zli(["agents", "--cwd", firstPath]);
    expect(listed.stderr).toBe("");
    const before = JSON.parse(listed.stdout) as Agents;
    expect(before.project).toBe("repo");
    expect(before.agents).toHaveLength(1);
    const first = before.agents[0];
    expect(first?.sameWorktree).toBe(true);

    const started = await zli([
      "start",
      "codex",
      "Write the changelog",
      "--branch",
      "docs/changelog",
      "--cwd",
      firstPath,
    ]);
    expect(started.stderr).toBe("");
    const helper = JSON.parse(started.stdout) as { agent: { id: string }; worktree: { branch: string; path: string } };
    expect(helper.worktree.branch).toBe("docs/changelog");
    await expect(page.locator(".agent-tile")).toHaveCount(2);

    await expect
      .poll(async () => (await zli(["read", helper.agent.id, "--cwd", firstPath])).stdout, { timeout: 20_000 })
      .toContain("Mock response");

    const sent = await zli(["send", first?.id ?? "", "The changelog is done.", "--cwd", helper.worktree.path]);
    expect(sent.stderr).toBe("");
    await expect(
      page.getByText(/Message from another agent in ZLI, working on branch docs\/changelog/u).first(),
    ).toBeVisible();

    await page.getByRole("button", { name: "Settings" }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings.getByRole("tab", { name: "Integrations" }).click();
    await settings.getByRole("tab", { name: "Installed" }).click();
    await settings.getByRole("button", { name: /^What agents may do with other agents: /u }).click();
    await page.getByRole("option", { name: "List and read agents" }).click();
    await expect(
      settings.getByRole("button", { name: "What agents may do with other agents: List and read agents" }),
    ).toBeVisible();
    const blocked = await zli(["send", helper.agent.id, "One more thing", "--cwd", firstPath]);
    expect(blocked.code).toBe(1);
    expect(blocked.stderr).toContain("not start or message them");
    expect((await zli(["agents", "--cwd", firstPath])).code).toBe(0);
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});
