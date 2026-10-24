import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { closeDesktop, createGitFixture, type DesktopFixture, launchDesktop } from "./desktop-fixtures.js";

test("adds MCP servers from the catalog and by remote URL", async () => {
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

    await settings.getByRole("button", { name: "Browse catalog" }).click();
    const catalog = settings.getByRole("region", { name: "MCP server catalog" });
    await catalog.getByRole("searchbox", { name: "Search servers" }).fill("memory");
    await expect(catalog.locator(".mcp-catalog-item")).toHaveCount(1);
    await catalog.getByRole("button", { name: "Add Memory" }).click();
    await expect(catalog.locator('[data-entry="memory"]')).toContainText("Added");

    await catalog.getByRole("searchbox", { name: "Search servers" }).fill("github");
    await catalog.getByRole("button", { name: "Add GitHub" }).click();
    const githubForm = catalog.getByRole("form", { name: "Add GitHub" });
    await githubForm.getByLabel("Personal access token").fill("ghp_e2e_secret");
    await githubForm.getByRole("button", { name: "Add server" }).click();
    await expect(catalog.locator('[data-entry="github"]')).toContainText("Added");
    await catalog.getByRole("button", { name: "Done" }).click();

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
      "https://mcp.linear.app/mcp · sign in with browser",
    ]);
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
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});
