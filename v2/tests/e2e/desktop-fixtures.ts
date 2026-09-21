import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";

const execFileAsync = promisify(execFile);
export const V2_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export type DesktopFixture = {
  app: ElectronApplication;
  page: Page;
  root: string;
  repo: string;
};

export async function createGitFixture(): Promise<{ root: string; repo: string }> {
  const root = await mkdtemp(join(tmpdir(), "zli-v2-e2e-"));
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  await writeFile(join(repo, "README.md"), "# ZLI integration fixture\n", "utf8");
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "zli-e2e@example.invalid"]);
  await git(repo, ["config", "user.name", "ZLI E2E"]);
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "fixture"]);
  await git(repo, ["branch", "-M", "main"]);
  return { root, repo };
}

export async function launchDesktop(repo: string, root: string): Promise<DesktopFixture> {
  const databasePath = join(root, "runtime.sqlite");
  const app = await electron.launch({
    args: [join(V2_ROOT, "apps/desktop/dist/main.js")],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      ZLI_DATABASE_PATH: databasePath,
      ZLI_RENDERER_ROOT: join(V2_ROOT, "apps/desktop/renderer"),
      ZLI_SERVER_ENTRY: join(V2_ROOT, "apps/desktop/dist/server-entry.js"),
      ZLI_TEST_PROJECT_PATH: repo,
      ZLI_TEST_PROVIDER: "mock",
    },
    timeout: 30_000,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.getByText("Local runtime").waitFor({ state: "visible" });
  return { app, page, root, repo };
}

export async function closeDesktop(fixture: DesktopFixture): Promise<void> {
  await fixture.app.close();
  await rm(fixture.root, { recursive: true, force: true });
}

export async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, windowsHide: true });
  return result.stdout.trim();
}
