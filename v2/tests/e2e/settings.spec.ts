import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { closeDesktop, createGitFixture, type DesktopFixture, launchDesktop } from "./desktop-fixtures.js";

test("changes New agent defaults, branch names, and shortcuts from Settings", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  const { root, repo } = await createGitFixture();
  let fixture: DesktopFixture | undefined;
  // Window storage outlives the test profile, so the person's own settings are put back afterwards.
  let saved: string | null = null;
  try {
    fixture = await launchDesktop(repo, root);
    const page = fixture.page;
    saved = await page.evaluate(() => window.localStorage.getItem("zli.settings.v1"));
    await expect(page.locator(".project-label")).toContainText("repo");

    await page.getByRole("button", { name: "Settings" }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings.getByRole("combobox", { name: "Agent" }).selectOption("codex");
    await settings.getByRole("combobox", { name: "Work in" }).selectOption("chat");

    await settings.getByRole("tab", { name: "Worktrees" }).click();
    await settings.getByLabel("Branch name template").fill("task/{agent}-{random}");
    await expect(settings).toContainText("task/codex-k3f9");

    await settings.getByRole("tab", { name: "Shortcuts" }).click();
    await settings.getByRole("button", { name: /^New agent, .+\. Change shortcut$/u }).click();
    await page.keyboard.press("Control+Shift+Y");
    await expect(settings.getByRole("button", { name: /^New agent, .+Y\. Change shortcut$/u })).toBeVisible();

    await settings.getByRole("tab", { name: "Notifications" }).click();
    const notify = settings.getByRole("switch", { name: /Notify when an agent finishes/u });
    await expect(notify).toBeChecked();
    await notify.click();
    await expect(notify).not.toBeChecked();
    await expect(settings.getByRole("switch", { name: "Play a sound" })).toBeDisabled();
    await notify.click();

    await page.keyboard.press("Escape");
    await expect(settings).toHaveCount(0);

    await page.keyboard.press("Control+Shift+Y");
    const newAgent = page.getByRole("dialog", { name: "New agent" });
    await expect(newAgent).toBeVisible();
    await expect(newAgent.getByRole("radio", { name: /Codex/u })).toBeChecked();
    await expect(newAgent.getByRole("radio", { name: /Chat/u })).toBeChecked();
    await newAgent.getByRole("radio", { name: /New worktree/u }).check();
    await expect(newAgent.getByLabel("Branch name")).toHaveValue(/^task\/codex-[a-z0-9]{4}$/u);
  } finally {
    if (fixture) {
      await fixture.page
        .evaluate((value) => {
          if (value === null) window.localStorage.removeItem("zli.settings.v1");
          else window.localStorage.setItem("zli.settings.v1", value);
        }, saved)
        .catch(() => undefined);
      await closeDesktop(fixture);
    }
  }
});

test("keeps MCP servers added in Settings for every agent", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  const { root, repo } = await createGitFixture();
  let fixture: DesktopFixture | undefined;
  try {
    fixture = await launchDesktop(repo, root);
    const page = fixture.page;
    await expect(page.locator(".project-label")).toContainText("repo");

    await page.getByRole("button", { name: "Settings" }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings.getByRole("tab", { name: "MCP servers" }).click();
    await expect(settings).toContainText("No servers yet.");
    await settings.getByRole("button", { name: "Add server" }).click();
    const form = settings.getByRole("form", { name: "New MCP server" });
    await form.getByLabel("Name").fill("github");
    await form.getByLabel("Command").fill("npx");
    await form.getByLabel("Arguments").fill("-y\n@modelcontextprotocol/server-github");
    await form.getByLabel("Environment").fill("GITHUB_TOKEN=test-token");
    await form.getByRole("button", { name: "Add server" }).click();
    await expect(form).toHaveCount(0);
    await expect(settings.locator(".mcp-row-command")).toHaveText("npx -y @modelcontextprotocol/server-github");
    await expect(settings).toContainText("this ZLI is set not to change those files");

    const saved = JSON.parse(await readFile(join(root, "mcp-servers.json"), "utf8"));
    expect(saved.servers).toEqual([
      {
        name: "github",
        enabled: true,
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: { GITHUB_TOKEN: "test-token" },
      },
    ]);

    await settings.getByRole("switch", { name: "Give agents github" }).click();
    await expect(settings.getByRole("switch", { name: "Give agents github" })).not.toBeChecked();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Settings" }).click();
    await settings.getByRole("tab", { name: "MCP servers" }).click();
    await expect(settings.getByRole("switch", { name: "Give agents github" })).not.toBeChecked();

    await settings.getByRole("button", { name: "Remove github" }).click();
    await settings.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(settings).toContainText("No servers yet.");
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});
