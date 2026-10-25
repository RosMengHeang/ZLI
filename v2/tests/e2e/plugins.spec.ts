import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { closeDesktop, createGitFixture, type DesktopFixture, launchDesktop } from "./desktop-fixtures.js";

test("installs a plugin from a folder and runs its action from the command palette", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  const { root, repo } = await createGitFixture();
  const source = join(root, "plugin-src");
  await mkdir(join(source, "commands"), { recursive: true });
  await writeFile(
    join(source, "zli-plugin.json"),
    JSON.stringify({
      name: "hello-kit",
      displayName: "Hello kit",
      description: "Greets the repository.",
      version: "0.1.0",
      userConfig: { token: { title: "API token", sensitive: true, required: true } },
      actions: [{ name: "Say hello", command: "echo hello-from-plugin" }],
    }),
  );
  await writeFile(join(source, "commands", "greet.md"), "---\ndescription: Greet\n---\nSay hello to the team.");
  await writeFile(
    join(source, ".mcp.json"),
    JSON.stringify({
      mcpServers: { hello: { command: "node", args: ["server.js"], env: { TOKEN: "${user_config.token}" } } },
    }),
  );
  let fixture: DesktopFixture | undefined;
  const shortcut = process.platform === "darwin" ? "Meta+k" : "Control+k";
  try {
    fixture = await launchDesktop(repo, root);
    const page = fixture.page;
    await expect(page.locator(".project-label")).toContainText("repo");

    await page.getByRole("button", { name: "Settings" }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings.getByRole("tab", { name: "Plugins" }).click();
    await expect(settings).toContainText("No plugins yet.");

    await settings.getByRole("button", { name: "Install plugin" }).click();
    const form = settings.getByRole("form", { name: "Install a plugin" });
    await form.getByLabel("Source").fill(source);
    await form.getByRole("button", { name: "Look up" }).click();
    await expect(form).toContainText("1 MCP server, 1 prompt, 1 action");
    await expect(form).toContainText("Say hello: echo hello-from-plugin");
    await form.getByRole("button", { name: "Install 1 plugin" }).click();

    const configure = settings.getByRole("form", { name: "Settings for Hello kit" });
    await expect(configure).toBeVisible();
    const row = settings.locator(".mcp-row", { hasText: "Hello kit" });
    await expect(row).toContainText("Add API token in the plugin's settings.");
    await configure.getByLabel("API token").fill("tok-123");
    await configure.getByRole("button", { name: "Save settings" }).click();
    await expect(configure).toHaveCount(0);
    await expect(row).not.toContainText("Add API token");
    await expect(row).toContainText("v0.1.0");
    await expect(settings).not.toContainText("tok-123");

    expect(await readFile(join(root, "plugins", "hello-kit", "commands", "greet.md"), "utf8")).toContain("Say hello");
    const state = join(root, "plugins.json");
    expect(await readFile(state, "utf8")).toContain("tok-123");
    if (process.platform !== "win32") expect((await stat(state)).mode & 0o777).toBe(0o600);

    await page.keyboard.press("Escape");
    await page.keyboard.press(shortcut);
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await palette.getByRole("textbox", { name: "Search commands" }).fill("say hello");
    await expect(palette.getByRole("button", { name: "Say hello (hello-kit)" })).toBeVisible();
    await palette.getByRole("textbox", { name: "Search commands" }).press("Enter");
    await expect(page.getByRole("log", { name: "Terminal output" }).last()).toContainText("hello-from-plugin", {
      timeout: 20_000,
    });

    await page.getByRole("button", { name: "Settings" }).click();
    await settings.getByRole("tab", { name: "Plugins" }).click();
    await settings.getByRole("switch", { name: "Turn on Hello kit" }).click();
    await expect(settings.getByRole("switch", { name: "Turn on Hello kit" })).not.toBeChecked();
    await settings.getByRole("button", { name: "Remove Hello kit" }).click();
    await settings.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(settings).toContainText("No plugins yet.");
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});
