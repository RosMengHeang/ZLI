import { type ChildProcess, execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { _electron as electron, type ElectronApplication, expect, type Page } from "@playwright/test";

import { closeChildProcess } from "../closeChildProcess.js";
import { getProcessTreeTerminationOrder } from "../processTree.js";

const execFileAsync = promisify(execFile);
export const V2_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export type DesktopFixture = {
  app: ElectronApplication;
  page: Page;
  root: string;
  repo: string;
};

export type DesktopLaunchOptions = {
  legacySnapshotPath?: string;
  /** Extra environment for the app and the runtime it starts, such as a PATH with stand-in CLIs. */
  env?: Record<string, string>;
};

/** Sends a message from the chat composer of a newly started Codex agent once it is ready. */
export async function sendChatMessage(page: Page, message: string): Promise<void> {
  const composer = page.getByRole("textbox", { name: "Message Codex" });
  await expect(composer).toBeEnabled({ timeout: 30_000 });
  await composer.fill(message);
  await composer.press("Enter");
}

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
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await launchOnce();
    } catch (error) {
      // A busy Windows runner sometimes never opens the first window of a new process. The failed
      // launch is already cleaned up, so starting again once is safe; any other failure is real.
      if (!(error instanceof WindowTimeout)) throw error;
      if (attempt >= 2) throw error.cause;
    }
  }

  async function launchOnce(): Promise<DesktopFixture> {
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
        ...options.env,
      },
      timeout: 30_000,
    });
    try {
      const page = await app.firstWindow().catch((error: unknown) => {
        throw new WindowTimeout(error);
      });
      await page.waitForLoadState("domcontentloaded");
      const runtime = page.getByText("Local runtime");
      const showSidebar = page.getByRole("button", { name: "Show sidebar" });
      await runtime.or(showSidebar).first().waitFor({ state: "visible" });
      // The window shares its profile with local dev runs, which can leave the sidebar hidden.
      if (await showSidebar.isVisible()) await showSidebar.click();
      await runtime.waitFor({ state: "visible" });
      return { app, page, root, repo };
    } catch (error) {
      // A launched app that never showed its window would otherwise outlive the test and stall worker shutdown.
      const child = app.process();
      await closeChildProcess(app.close.bind(app), child, () => terminateProcessTree(child.pid)).catch(() => undefined);
      releaseStdio(child);
      await stopDesktopDaemon(root).catch(() => undefined);
      throw error;
    }
  }
}

class WindowTimeout extends Error {
  constructor(cause: unknown) {
    super("The app window did not open.", { cause });
  }
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

export async function closeApp(
  fixture: DesktopFixture,
  options: { stopTerminals?: boolean; processTree?: number[]; child?: ChildProcess } = {},
): Promise<void> {
  if (options.stopTerminals !== false) await stopTerminals(fixture.page);
  // Playwright drops its handle to the main process once it exits, so a crashed app must pass the child it captured.
  const child = options.child ?? fixture.app.process();
  const processTree = options.processTree ?? (await captureProcessTree(child.pid));
  await closeChildProcess(fixture.app.close.bind(fixture.app), child, async () => {
    if (process.platform === "win32") {
      await terminateProcessTree(child.pid);
      return;
    }
    for (const pid of processTree) signalProcess(pid, "SIGTERM");
    await delay(150);
    for (const pid of processTree) {
      if (isProcessAlive(pid)) signalProcess(pid, "SIGKILL");
    }
  });
  releaseStdio(child);
}

/**
 * Playwright tracks a launched app until its stdio pipes close, and waits for that when the worker shuts
 * down. A helper process that outlives a killed app can hold the pipes open, so close them from this side.
 */
function releaseStdio(child: ChildProcess): void {
  for (const stream of child.stdio) stream?.destroy();
}

async function terminateProcessTree(pid: number | undefined): Promise<void> {
  if (!pid) return;
  if (process.platform === "win32") {
    await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }).catch(() => undefined);
    return;
  }
  const processTree = await captureProcessTree(pid);
  for (const processPid of processTree) signalProcess(processPid, "SIGTERM");
  await delay(150);
  for (const processPid of processTree) {
    if (isProcessAlive(processPid)) signalProcess(processPid, "SIGKILL");
  }
}

export async function captureProcessTree(rootPid: number | undefined): Promise<number[]> {
  if (!rootPid) return [];
  if (process.platform === "win32") return [rootPid];
  try {
    const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid="], { timeout: 5_000 });
    return getProcessTreeTerminationOrder(rootPid, stdout);
  } catch {
    return [rootPid];
  }
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
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
    const bridge = window.zli;
    if (!bridge) throw new Error("The ZLI bridge is unavailable in the renderer.");
    for (const terminalId of ids) {
      await bridge.runtime.dispatch({
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
