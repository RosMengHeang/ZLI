import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { closeDesktop, createGitFixture, type DesktopFixture, launchDesktop } from "./desktop-fixtures.js";

test("adds connectors from the gallery and MCP servers by remote URL", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  const { root, repo } = await createGitFixture();
  let fixture: DesktopFixture | undefined;
  try {
    fixture = await launchDesktop(repo, root);
    const page = fixture.page;
    await expect(page.locator(".project-label")).toContainText("repo");

    await page.getByRole("button", { name: "Settings" }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings.getByRole("tab", { name: "Connectors" }).click();
    await expect(settings.locator('[data-entry="vercel"]')).toContainText("Vercel");
    await expect(settings.locator('[data-entry="vercel"] .connector-logo')).toBeVisible();

    const search = settings.getByRole("searchbox", { name: "Search connectors" });
    await search.fill("memory");
    await expect(settings.locator(".connector-card")).toHaveCount(1);
    await settings.getByRole("button", { name: "Add Memory" }).click();
    await expect(settings.locator('[data-entry="memory"]')).toHaveAttribute("data-state", "connected");

    await search.fill("github");
    const github = settings.locator('[data-entry="github"]');
    await github.getByRole("button", { name: "Use a token" }).click();
    const githubForm = github.getByRole("form", { name: "Connect GitHub" });
    await githubForm.getByLabel("Personal access token").fill("ghp_e2e_secret");
    await githubForm.getByRole("button", { name: "Connect" }).click();
    await expect(github).toHaveAttribute("data-state", "connected");
    await search.fill("");
    await expect(settings.getByRole("button", { name: "Connected (2)" })).toBeVisible();

    await settings.getByRole("tab", { name: "MCP servers" }).click();
    await settings.getByRole("button", { name: "Add server" }).click();
    const form = settings.getByRole("form", { name: "New MCP server" });
    await form.getByLabel("Name").fill("linear");
    // The list closes on scroll, and scrolling the trigger into view can land just after the click.
    const remoteOption = page.getByRole("option", { name: "Remote server", exact: true });
    await expect(async () => {
      if (!(await remoteOption.isVisible())) await form.getByRole("button", { name: /^Type: / }).click();
      await remoteOption.click({ timeout: 1_000 });
    }).toPass();
    await expect(form.getByRole("button", { name: "Type: Remote server" })).toBeVisible();
    await form.getByLabel("URL").fill("https://mcp.linear.app/mcp");
    await form.getByLabel("Sign in with browser (OAuth)").check();
    await form.getByRole("button", { name: "Add server" }).click();
    await expect(form).toHaveCount(0);

    const rows = settings.locator(".mcp-row-command");
    await expect(rows).toHaveText([
      "npx -y @modelcontextprotocol/server-memory",
      "https://api.githubcopilot.com/mcp/ · Authorization: ••••",
      "https://mcp.linear.app/mcp",
    ]);
    await expect(
      settings.locator(".mcp-row", { hasText: "mcp.linear.app" }).getByRole("button", { name: /Sign in/ }),
    ).toBeVisible();
    await expect(settings).not.toContainText("ghp_e2e_secret");
    await expect(settings).toContainText("Goose in a terminal cannot send headers");

    const saved = JSON.parse(await readFile(join(root, "mcp-servers.json"), "utf8"));
    expect(saved.servers).toEqual([
      { name: "memory", enabled: true, command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"], env: {} },
      {
        name: "github",
        enabled: true,
        transport: "http",
        url: "https://api.githubcopilot.com/mcp/",
        headers: { Authorization: "Bearer ghp_e2e_secret" },
        oauth: false,
      },
      {
        name: "linear",
        enabled: true,
        transport: "http",
        url: "https://mcp.linear.app/mcp",
        headers: {},
        oauth: true,
      },
    ]);

    await settings.getByRole("button", { name: "Edit github" }).click();
    const edit = settings.getByRole("form", { name: "Edit MCP server" });
    await expect(edit.getByLabel("URL")).toHaveValue("https://api.githubcopilot.com/mcp/");
    await edit.getByRole("button", { name: "Cancel" }).click();

    await settings.getByRole("button", { name: "Browse connectors" }).click();
    await expect(settings.getByRole("searchbox", { name: "Search connectors" })).toBeVisible();
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});
