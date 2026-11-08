import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, type Page, test } from "@playwright/test";

import { closeDesktop, createGitFixture, type DesktopFixture, launchDesktop } from "./desktop-fixtures.js";

const jsonl = (...lines: unknown[]) => `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;

/** A home folder with one past Claude Code chat in the fixture repository, so the scan is predictable. */
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
  return home;
}

/** Starts ZLI as a fresh install would: no test project, and a home with one past chat. */
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

test("imports a past chat and lands on it, ready for the next message", async () => {
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
    // The project is found from the past chat and starts ticked.
    await expect(dialog.getByRole("checkbox", { name: /repo/ })).toBeChecked();
    await shot(page, "3-projects");
    await dialog.getByRole("button", { name: /1 chat/ }).click();
    await expect(dialog.getByText("Add a health check endpoint")).toBeVisible();
    await shot(page, "3-projects-open");
    await dialog.getByRole("button", { name: "Import 1 project and open" }).click();

    // Setup closes on the imported chat itself, with its messages and a composer that resumes it.
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await expect(page.getByText("Added GET /health that returns ok.")).toBeVisible();
    await expect(page.getByText(/next message picks up where it left off/)).toBeVisible();
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
    await shot(page, "6-landed-terminal");
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});
