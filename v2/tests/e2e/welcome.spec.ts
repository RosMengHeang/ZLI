import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, type Page, test } from "@playwright/test";

import { closeDesktop, createGitFixture, type DesktopFixture, launchDesktop } from "./desktop-fixtures.js";

const jsonl = (...lines: unknown[]) => `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;

/**
 * A home folder with past Claude Code sessions: the newest in the fixture repository and older ones in
 * three other folders, so the scan is predictable and setup adds more projects than the one it opens.
 */
async function fakeHome(root: string, repo: string): Promise<string> {
  const home = join(root, "home");
  // Electron reads its own folders from the home on Windows, so they have to exist there too.
  await mkdir(join(home, "AppData", "Roaming"), { recursive: true });
  await mkdir(join(home, "AppData", "Local"), { recursive: true });
  const transcripts = join(home, ".claude", "projects", "repo");
  await mkdir(transcripts, { recursive: true });
  const record = (type: "user" | "assistant", text: string, timestamp: string) => ({
    type,
    sessionId: "11111111-2222-4333-8444-555555555555",
    cwd: repo,
    timestamp,
    message:
      type === "user" ? { role: "user", content: text } : { role: "assistant", content: [{ type: "text", text }] },
  });
  await writeFile(
    join(transcripts, "11111111-2222-4333-8444-555555555555.jsonl"),
    jsonl(
      record("user", "Add a health check endpoint", "2026-11-01T10:00:00.000Z"),
      record("assistant", "Added GET /health that returns ok.", "2026-11-01T10:00:05.000Z"),
    ),
  );
  const older = new Date("2026-10-01T00:00:00.000Z");
  for (const name of ["api", "docs", "site"]) {
    const folder = join(root, name);
    await mkdir(folder, { recursive: true });
    const file = join(home, ".claude", "projects", name, `${name}.jsonl`);
    await mkdir(join(home, ".claude", "projects", name), { recursive: true });
    await writeFile(
      file,
      jsonl({ type: "user", sessionId: name, cwd: folder, message: { role: "user", content: "Hi" } }),
    );
    await utimes(file, older, older);
  }
  return home;
}

/** Starts ZLI as a fresh install would: no test project, and a home with one past session. */
async function launchFresh(): Promise<DesktopFixture> {
  const { root, repo } = await createGitFixture();
  const home = await fakeHome(root, repo);
  return launchDesktop(repo, root, {
    env: {
      ZLI_TEST_PROJECT_PATH: "",
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, "AppData", "Roaming"),
      LOCALAPPDATA: join(home, "AppData", "Local"),
    },
  });
}

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.ZLI_WELCOME_SHOTS;
  if (dir) await page.screenshot({ path: join(dir, `${name}.png`) });
}

test("finds the project from past sessions and opens a fresh chat in it", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  let fixture: DesktopFixture | undefined;
  try {
    fixture = await launchFresh();
    const page = fixture.page;
    const dialog = page.getByRole("dialog", { name: "Welcome to ZLI" });
    await expect(dialog.getByText("Your agents")).toBeVisible();
    await shot(page, "1-agent");

    // Discovery can find no agent on a CI runner; setup still moves on once one is ready.
    const continueButton = dialog.getByRole("button", { name: "Continue" });
    if (await continueButton.isDisabled()) return;
    await continueButton.click();
    await expect(dialog.getByText("How do you want to work?")).toBeVisible();
    await expect(dialog.getByRole("radio", { name: /^Chat/ })).toBeChecked();
    await shot(page, "2-workspace");

    await continueButton.click();
    // The projects found in past sessions start unticked; the person picks them, or selects them all.
    await expect(dialog.getByRole("checkbox", { name: /repo/ })).not.toBeChecked();
    await expect(dialog.getByRole("checkbox")).toHaveCount(4);
    await dialog.getByRole("button", { name: "Select all" }).click();
    await expect(dialog.getByRole("checkbox", { name: /repo/ })).toBeChecked();
    await shot(page, "3-projects");
    await dialog.getByRole("button", { name: "Add 4 projects and open" }).click();

    // Setup closes on a new chat in that project, with none of the old session's messages.
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    // The message box is ready to type in, so the first thing the person does is write the task.
    await expect(page.getByRole("textbox", { name: /^Message / })).toBeFocused({ timeout: 30_000 });
    await expect(page.getByText("Added GET /health that returns ok.")).toHaveCount(0);
    // Only the project in use is listed; the other three wait folded under one row.
    const sidebar = page.getByRole("complementary", { name: "Projects and agents" });
    await expect(sidebar.getByRole("button", { name: "3 more projects" })).toBeVisible();
    await expect(sidebar.getByRole("button", { name: "Start an agent in api" })).toHaveCount(0);
    await shot(page, "4-landed-chat");
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});

test("lands a terminal person in the agent's CLI in the folder they added", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  let fixture: DesktopFixture | undefined;
  try {
    fixture = await launchFresh();
    const page = fixture.page;
    const dialog = page.getByRole("dialog", { name: "Welcome to ZLI" });
    const continueButton = dialog.getByRole("button", { name: "Continue" });
    await expect(dialog.getByText("Your agents")).toBeVisible();
    if (await continueButton.isDisabled()) return;
    await continueButton.click();
    await dialog.getByText("Terminal", { exact: true }).click();
    await expect(dialog.getByRole("radio", { name: /^Terminal/ })).toBeChecked();
    await continueButton.click();

    // The native folder picker can't be driven from the test, so it answers with the fixture repository.
    await fixture.app.evaluate(({ dialog: native }, path) => {
      native.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, fixture.repo);
    await dialog.getByRole("button", { name: /Add a folder/ }).click();
    await expect(dialog.getByText("Opens Codex in repo")).toBeVisible();
    await shot(page, "5-projects-folder");
    await dialog.getByRole("button", { name: /and open|Open ZLI/ }).click();

    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await expect(page.locator(".xterm").first()).toBeVisible({ timeout: 30_000 });
    // Keys go straight to the agent's CLI.
    await expect(page.locator(".xterm-helper-textarea").first()).toBeFocused();
    await shot(page, "6-landed-terminal");
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});
