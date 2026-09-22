import { execFile } from "node:child_process";
import { createHook } from "node:async_hooks";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getActiveResourcesInfo } from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { _electron as electron, test, type ElectronApplication, type Page } from "@playwright/test";

const execFileAsync = promisify(execFile);
export const V2_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const activeAsyncResources = new Map<number, { type: string; triggerAsyncId: number; stack: string[] }>();
const linuxCiDiagnostics = process.platform === "linux" && process.env.CI === "true";
if (linuxCiDiagnostics) {
  createHook({
    init(asyncId, type, triggerAsyncId) {
      if (!/^(?:FSREQCALLBACK|PIPEWRAP|TCPWRAP|TCPCONNECTWRAP|Timeout)$/u.test(type)) return;
      activeAsyncResources.set(asyncId, {
        type,
        triggerAsyncId,
        stack:
          new Error().stack
            ?.split("\n")
            .slice(2, 7)
            .map((line) => line.trim()) ?? [],
      });
      while (activeAsyncResources.size > 250) {
        const oldest = activeAsyncResources.keys().next().value as number | undefined;
        if (oldest === undefined) break;
        activeAsyncResources.delete(oldest);
      }
    },
    destroy(asyncId) {
      activeAsyncResources.delete(asyncId);
    },
  }).enable();
}

export type DesktopFixture = {
  app: ElectronApplication;
  page: Page;
  root: string;
  repo: string;
};

export type DesktopLaunchOptions = {
  legacySnapshotPath?: string;
};

test.afterEach(() => {
  if (linuxCiDiagnostics) {
    console.log(`[e2e-active-resources] ${JSON.stringify(getActiveResourcesInfo())}`);
    console.log(`[e2e-resource-origins] ${JSON.stringify([...activeAsyncResources.entries()].slice(-30))}`);
  }
});

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

export async function launchDesktop(
  repo: string,
  root: string,
  options: DesktopLaunchOptions = {},
): Promise<DesktopFixture> {
  const databasePath = join(root, "runtime.sqlite");
  const externalExecutable = process.env.ZLI_ELECTRON_EXECUTABLE;
  const packagedExecutable = externalExecutable
    ? undefined
    : process.env.ZLI_E2E_PACKAGED === "1"
      ? await findPackagedExecutable()
      : undefined;
  const executablePath = externalExecutable ?? packagedExecutable;
  const app = await electron.launch({
    args: executablePath
      ? packagedExecutable
        ? []
        : [join(V2_ROOT, "apps/desktop/dist/main.js")]
      : [join(V2_ROOT, "apps/desktop/dist/main.js")],
    ...(executablePath ? { executablePath } : {}),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      ...(externalExecutable ? { ZLI_RUNTIME_NODE: process.execPath } : { ZLI_RUNTIME_NODE: undefined }),
      ZLI_DATABASE_PATH: databasePath,
      ...(packagedExecutable
        ? {}
        : {
            ZLI_RENDERER_ROOT: join(V2_ROOT, "apps/desktop/renderer"),
            ZLI_SERVER_ENTRY: join(V2_ROOT, "apps/desktop/dist/server-entry.js"),
          }),
      ZLI_TEST_PROJECT_PATH: repo,
      ZLI_TEST_PROVIDER: "mock",
      ZLI_TEST_LEGACY_SNAPSHOT_PATH: options.legacySnapshotPath,
    },
    timeout: 30_000,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.getByText("Local runtime").waitFor({ state: "visible" });
  return { app, page, root, repo };
}

async function findPackagedExecutable(): Promise<string> {
  const releaseRoot = join(V2_ROOT, "apps/desktop/release");
  const candidates =
    process.platform === "win32"
      ? [join(releaseRoot, "win-unpacked", "ZLI.exe")]
      : process.platform === "darwin"
        ? [
            join(releaseRoot, "mac", "ZLI.app", "Contents", "MacOS", "ZLI"),
            join(releaseRoot, "mac-arm64", "ZLI.app", "Contents", "MacOS", "ZLI"),
            join(releaseRoot, "mac-x64", "ZLI.app", "Contents", "MacOS", "ZLI"),
          ]
        : [join(releaseRoot, "linux-unpacked", "ZLI"), join(releaseRoot, "linux-unpacked", "zli")];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next electron-builder layout for this platform.
    }
  }
  throw new Error(`Packaged ZLI executable was not found under ${releaseRoot}.`);
}

export async function closeDesktop(fixture: DesktopFixture): Promise<void> {
  await closeApp(fixture);
  await stopDesktopDaemon(fixture.root);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(fixture.root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!(error instanceof Error) || !["EBUSY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? ""))
        throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
  }
  await rm(fixture.root, { recursive: true, force: true });
}

export async function stopDesktopDaemon(root: string): Promise<void> {
  let endpoint: { pid?: unknown; host?: unknown; port?: unknown; token?: unknown };
  try {
    endpoint = JSON.parse(await readFile(join(root, "runtime.sqlite.daemon.json"), "utf8")) as typeof endpoint;
  } catch {
    return;
  }
  if (
    !Number.isSafeInteger(endpoint.pid) ||
    typeof endpoint.pid !== "number" ||
    endpoint.pid <= 0 ||
    endpoint.pid === process.pid ||
    endpoint.host !== "127.0.0.1" ||
    typeof endpoint.port !== "number" ||
    typeof endpoint.token !== "string"
  ) {
    return;
  }
  await terminateProcessTree(endpoint.pid);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      process.kill(endpoint.pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await delay(100);
  }
}

export async function closeApp(fixture: DesktopFixture, options: { stopTerminals?: boolean } = {}): Promise<void> {
  if (options.stopTerminals !== false) await stopTerminals(fixture.page);
  const child = fixture.app.process();
  const closeContext = fixture.app.close().catch(() => undefined);
  await terminateProcessTree(child.pid);
  await Promise.race([
    closeContext,
    new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
    delay(2_000),
  ]);
}

async function terminateProcessTree(pid: number | undefined): Promise<void> {
  if (!pid) return;
  if (process.platform === "win32") {
    await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }).catch(() => undefined);
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* The process already exited. */
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function stopTerminals(page: Page): Promise<void> {
  const terminalIds = await page.evaluate(async () => {
    const projection = await window.zli?.runtime.getProjection();
    return (
      projection?.terminals
        .filter((terminal) => terminal.status === "running" || terminal.status === "starting")
        .map((terminal) => terminal.terminalId) ?? []
    );
  });
  if (terminalIds.length === 0) return;
  await page.evaluate(async (ids) => {
    for (const terminalId of ids) {
      await window.zli!.runtime.dispatch({
        protocolVersion: 1,
        commandId: crypto.randomUUID(),
        command: { type: "terminal.stop", terminalId },
      });
    }
  }, terminalIds);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const stillRunning = await page.evaluate(async (ids) => {
      const projection = await window.zli?.runtime.getProjection();
      return (
        projection?.terminals.some(
          (terminal) =>
            ids.includes(terminal.terminalId) && (terminal.status === "running" || terminal.status === "starting"),
        ) ?? false
      );
    }, terminalIds);
    if (!stillRunning) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
}

export async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, windowsHide: true });
  return result.stdout.trim();
}
