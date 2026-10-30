import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";

import {
  closeDesktop,
  createGitFixture,
  type DesktopFixture,
  git,
  launchDesktop,
  V2_ROOT,
} from "./desktop-fixtures.js";

const execFileAsync = promisify(execFile);

function zliIn(root: string) {
  return async (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
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
}

type Agents = { project: string; agents: Array<{ id: string; sameWorktree: boolean; branch: string }> };

test("lets agents list, start, read, and message each other with the zli command", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  const { root, repo } = await createGitFixture();
  let fixture: DesktopFixture | undefined;
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  const zli = zliIn(root);
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
    await expect(
      page.getByText(/^Task from the agent in ZLI that started you, working on branch /u).first(),
    ).toBeVisible();

    await expect
      .poll(async () => (await zli(["read", helper.agent.id, "--cwd", firstPath])).stdout, { timeout: 20_000 })
      .toContain("Mock response");

    const sent = await zli(["send", first?.id ?? "", "The changelog is done.", "--cwd", helper.worktree.path]);
    expect(sent.stderr).toBe("");
    await expect(
      page.getByText(/Message from your sub-agent, working on branch docs\/changelog/u).first(),
    ).toBeVisible();

    await page.getByRole("button", { name: "Settings" }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings.getByRole("tab", { name: "Agent messages" }).click();
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

test("finds an agent in another project by name once the person allows it", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  const { root, repo } = await createGitFixture();
  const web = join(root, "web");
  await mkdir(web);
  await writeFile(join(web, "README.md"), "# Web\n", "utf8");
  await git(web, ["init"]);
  await git(web, ["config", "user.email", "zli-e2e@example.invalid"]);
  await git(web, ["config", "user.name", "ZLI E2E"]);
  await git(web, ["add", "README.md"]);
  await git(web, ["commit", "-m", "fixture"]);
  await git(web, ["branch", "-M", "main"]);
  const zli = zliIn(root);
  let fixture: DesktopFixture | undefined;
  try {
    fixture = await launchDesktop(repo, root);
    const { page } = fixture;
    await expect(page.locator(".project-label").first()).toContainText("repo");
    const registered = await page.evaluate(
      async (path) =>
        window.zli?.runtime.dispatch({
          protocolVersion: 1,
          commandId: crypto.randomUUID(),
          command: { type: "project.register", path },
        }),
      web,
    );
    expect(registered?.accepted).toBe(true);
    await expect(page.locator(".project-label")).toHaveCount(2);
    // Agents work in a worktree, so each project gets its checkout the way New agent adds it.
    for (const path of [repo, web]) {
      const imported = await page.evaluate(async (projectPath) => {
        const projection = await window.zli?.runtime.getProjection();
        const project = projection?.projects.find((candidate) => candidate.path === projectPath);
        return window.zli?.runtime.dispatch({
          protocolVersion: 1,
          commandId: crypto.randomUUID(),
          command: {
            type: "worktree.import",
            worktreeId: crypto.randomUUID(),
            projectId: project?.projectId,
            path: projectPath,
            branch: "HEAD",
            kind: "checkout",
          },
        });
      }, path);
      expect(imported?.accepted).toBe(true);
      await expect
        .poll(
          () =>
            page.evaluate(async (projectPath) => {
              const projection = await window.zli?.runtime.getProjection();
              return projection?.worktrees.some(
                (worktree) => worktree.path === projectPath && worktree.status === "ready",
              );
            }, path),
          { timeout: 20_000 },
        )
        .toBe(true);
    }

    for (const [name, cwd] of [
      ["Bob", repo],
      ["Kim", web],
    ] as const) {
      const started = await zli([
        "start",
        "codex",
        "Wait for messages.",
        "--name",
        name,
        "--same-worktree",
        "--cwd",
        cwd,
      ]);
      expect(started.stderr).toBe("");
    }
    await expect(page.locator(".agent-tile")).toHaveCount(2);

    const listed = JSON.parse((await zli(["agents", "--cwd", repo])).stdout) as {
      you?: { name?: string };
      agents: Array<{ name?: string; you?: boolean }>;
    };
    expect(listed.you?.name).toBe("Bob");
    expect(listed.agents.find((agent) => agent.you)?.name).toBe("Bob");

    // Settings keep agents to their own project, so ZLI asks the person while the command waits.
    const sending = zli(["send", "KIM", "hi", "--cwd", repo]);
    const ask = page.getByRole("dialog", { name: "Let agents reach other projects" });
    await expect(ask.getByRole("heading", { name: "Let Bob message Kim?" })).toBeVisible({ timeout: 20_000 });
    await ask.getByRole("button", { name: "Allow every project" }).click();
    const sent = await sending;
    expect(sent.stderr).toBe("");
    expect(JSON.parse(sent.stdout)).toMatchObject({ agent: { name: "Kim", project: "web" } });
    await expect(page.getByText(/Message to Kim from Bob, an agent in the ZLI project repo/u).first()).toBeVisible();

    await page.getByRole("button", { name: "Settings" }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings.getByRole("tab", { name: "Agent messages" }).click();
    await expect(settings.getByRole("button", { name: "Which agents they can reach: In every project" })).toBeVisible();
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});
