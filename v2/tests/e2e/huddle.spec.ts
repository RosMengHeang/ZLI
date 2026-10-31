import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, type Page, test } from "@playwright/test";

import { closeDesktop, createGitFixture, type DesktopFixture, launchDesktop, V2_ROOT } from "./desktop-fixtures.js";

const execFileAsync = promisify(execFile);

type Agents = { agents: Array<{ id: string; name?: string; sameWorktree: boolean }> };

test("runs a huddle where agents and the person talk, assign work, and pin a decision", async () => {
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
    // Tiles from earlier runs live in localStorage and would crowd the grid.
    await page.evaluate(() => localStorage.removeItem("zli.workbench.v1"));
    await page.reload();
    await expect(page.getByRole("status").filter({ hasText: "Runtime connected" })).toBeVisible();
    await expect(page.locator(".project-label")).toContainText("repo");

    await page.keyboard.press(`${mod}+n`);
    const dialog = page.getByRole("dialog", { name: "New agent" });
    await dialog.getByText("Codex", { exact: true }).click();
    await dialog.getByText("Chat", { exact: true }).click();
    await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Lead");
    await dialog.getByRole("button", { name: "Start agent" }).click();
    // Waiting through a locator lets the fixture answer the one-time "Let agents work" question.
    await expect(page.getByRole("textbox", { name: "Message Lead" })).toBeEnabled({ timeout: 30_000 });
    const leadPath = await idleWorktreePath(page);

    const started = await zli(["start", "codex", "Wait for the huddle.", "--name", "Helper", "--cwd", leadPath]);
    expect(started.stderr).toBe("");
    const helperPath = (JSON.parse(started.stdout) as { worktree: { path: string } }).worktree.path;
    await expect(page.locator(".agent-tile")).toHaveCount(2);
    // Helper's first answer lands while its tile settles; adding it to the huddle waits until then.
    const helperTile = page.getByRole("region", { name: /^Helper,/u });
    await expect(helperTile.getByText(/^Mock response/u).first()).toBeVisible({ timeout: 20_000 });

    await page.getByRole("button", { name: "Huddle", exact: true }).click();
    const pane = page.getByRole("region", { name: "Huddle", exact: true });
    await pane.getByRole("button", { name: "New huddle" }).click();
    await pane.getByRole("textbox", { name: "Huddle name" }).fill("Login plan");
    await pane.getByRole("textbox", { name: "Huddle name" }).press("Enter");

    for (const name of ["Lead", "Helper"]) await addToHuddle(page, name, "Login plan");
    await expect(pane.getByText("Lead", { exact: true }).first()).toBeVisible();

    const notIn = await zli(["huddle", "read", "--cwd", repo]);
    expect(notIn.code).toBe(1);

    await pane.getByRole("textbox", { name: "Message to the huddle" }).fill("How should we split the login work?");
    await pane.getByRole("textbox", { name: "Message to the huddle" }).press(`${mod}+Enter`);
    // Each chat answers with the mock reply, and ZLI posts both answers back to the huddle.
    const answers = pane.getByText("Answer from chat", { exact: true });
    await expect(answers).toHaveCount(2, { timeout: 30_000 });

    const read = await zli(["huddle", "read", "--cwd", helperPath]);
    expect(read.stderr).toBe("");
    const transcript = JSON.parse(read.stdout) as { huddle: string; messages: Array<{ from: string; text: string }> };
    expect(transcript.huddle).toBe("Login plan");
    expect(transcript.messages[0]).toMatchObject({ from: "the person", text: "How should we split the login work?" });

    const assigned = await zli([
      "huddle",
      "post",
      "Lead, please review the session schema.",
      "--to",
      "Lead",
      "--kind",
      "assign",
      "--cwd",
      helperPath,
    ]);
    expect(assigned.stderr).toBe("");
    const post = pane.getByRole("listitem", { name: /^Message \d+ from Helper$/u }).filter({
      hasText: "Lead, please review the session schema.",
    });
    await expect(post).toBeVisible();
    // Lead answers the task, and its answer comes back as the third chat answer.
    await expect(answers).toHaveCount(3, { timeout: 30_000 });

    await post.getByRole("button", { name: "Pin as decision" }).click();
    await expect(post.getByRole("button", { name: "Unpin decision" })).toBeVisible();
    await expect
      .poll(async () => (await zli(["huddle", "decisions", "--cwd", leadPath])).stdout, { timeout: 10_000 })
      .toContain("Lead, please review the session schema.");

    const agents = JSON.parse((await zli(["agents", "--cwd", leadPath])).stdout) as Agents;
    expect(agents.agents.map((agent) => agent.name)).toEqual(["Lead", "Helper"]);
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});

async function idleWorktreePath(page: Page): Promise<string> {
  let path = "";
  await expect
    .poll(
      async () => {
        path = await page.evaluate(async () => {
          const projection = await window.zli?.runtime.getProjection();
          const thread = projection?.threads.find((candidate) => candidate.status === "idle");
          return projection?.worktrees.find((worktree) => worktree.worktreeId === thread?.worktreeId)?.path ?? "";
        });
        return path;
      },
      { timeout: 20_000 },
    )
    .not.toBe("");
  return path;
}

/** Adds an agent through its tile menu, as the person would without dragging. */
async function addToHuddle(page: Page, agent: string, huddle: string): Promise<void> {
  // A sub-agent's tile also names its starter, so match the tile's own label.
  const tile = page.getByRole("region", { name: new RegExp(`^${agent},`, "u") });
  await tile.getByRole("button", { name: "Add to huddle" }).click();
  // The menu can open over the title bar. Playwright's clicks skip the window's drag region, so check that the
  // menu opts out of it rather than trusting the click below.
  const menu = page.getByRole("menu", { name: "Add to huddle" });
  await expect
    .poll(() =>
      menu.evaluate((list) => getComputedStyle(list.closest(".menu") ?? list).getPropertyValue("-webkit-app-region")),
    )
    .toBe("no-drag");
  await page.getByRole("menuitemcheckbox", { name: huddle }).click();
}
