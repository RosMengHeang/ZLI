import { type ChildProcess, execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";

import { closeChildProcess } from "../closeChildProcess.js";
import { electronChildProcess } from "../electronChildProcess.js";
import { getProcessTreeTerminationOrder } from "../processTree.js";

const execFileAsync = promisify(execFile);

/** How long launch waits for the first window. A busy Windows runner sometimes never opens one. */
const WINDOW_TIMEOUT_MS = 30_000;
/** That wait, plus closing the process, is given back to the test so teardown still fits. */
const RELAUNCH_BUDGET_MS = WINDOW_TIMEOUT_MS + 15_000;

/**
 * The terminal draws with WebGL where the GPU allows it, which leaves no text in the page for the tests
 * to read. Without WebGL it falls back to the DOM renderer, as it already does on Linux runners.
 * Chromium's --disable-webgl switch reaches Electron but does not stop the page from getting a context.
 */
const DISABLE_WEBGL = `(() => {
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    return type === "webgl" || type === "webgl2" ? null : getContext.call(this, type, ...rest);
  };
})();`;

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
  /** Answers yes when the app asks to let agents work in the project. On unless a test checks that question. */
  trustAgents?: boolean;
};

/** Sends a message from the chat composer of a newly started Codex agent once it is ready. */
export async function sendChatMessage(page: Page, message: string): Promise<void> {
  const composer = page.getByRole("textbox", { name: "Message Codex" });
  await expect(composer).toBeEnabled({ timeout: 30_000 });
  await composer.fill(message);
  // The text box takes input while the agent starts, but Send stays off until it is ready.
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled({ timeout: 30_000 });
  await composer.press("Enter");
}

/**
 * A port nothing is listening on, for a dev server the test starts in an agent's terminal. A random pick
 * from a fixed range can land on a port another process already holds, since that range sits inside the
 * one the OS hands out for outgoing connections.
 */
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  if (!address || typeof address === "string") throw new Error("No free port was found.");
  return address.port;
}

/**
 * Clicks one of a sidebar project row's actions. They are display:none until the row is hovered, and a
 * role query skips display:none, so a hover that does not stick makes the lookup wait until it times out.
 * Put every action on the row back in the layout, then click.
 */
export async function clickProjectAction(row: Locator, button: Locator): Promise<void> {
  await expect(async () => {
    await revealProjectActions(row);
    await button.click({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

/** Opens the Create worktree dialog from the first project's row. */
export async function openCreateWorktree(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Create worktree" });
  const row = page.locator(".project-label").first();
  // New worktree sits in the project's menu, so the row keeps only New chat and the menu on hover.
  const menu = row.getByRole("button", { name: / actions$/u });
  const item = page.getByRole("menuitem", { name: "New worktree" });
  // The scrim covers the sidebar button. A click that already opened the dialog is still reported
  // as a miss, and every retry then times out on that same scrim.
  await expect(async () => {
    if (await dialog.isVisible()) return;
    await revealProjectActions(row);
    try {
      if (!(await item.isVisible())) await menu.click({ timeout: 2_000 });
      await item.click({ timeout: 2_000 });
    } catch (error) {
      if (await dialog.isVisible()) return;
      throw error;
    }
  }).toPass({ timeout: 30_000 });
  await expect(dialog).toBeVisible();
}

function revealProjectActions(row: Locator): Promise<void> {
  return row.evaluate((label) => {
    for (const element of label.querySelectorAll<HTMLElement>(".project-action")) {
      element.style.setProperty("display", "inline-flex");
      element.style.setProperty("opacity", "1");
    }
  });
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

export type DesktopCommand = {
  /** Unset when Playwright starts the Electron binary from node_modules. */
  executablePath?: string;
  args: string[];
  env: NodeJS.ProcessEnv;
};

/** The command launchDesktop starts the app with, for a test that starts another copy on the same data. */
export async function desktopCommand(
  repo: string,
  root: string,
  options: DesktopLaunchOptions = {},
): Promise<DesktopCommand> {
  const databasePath = join(root, "runtime.sqlite");
  const externalExecutable = process.env.ZLI_ELECTRON_EXECUTABLE;
  const packagedExecutable = externalExecutable
    ? undefined
    : process.env.ZLI_E2E_PACKAGED === "1"
      ? await findPackagedExecutable()
      : undefined;
  const executablePath = externalExecutable ?? packagedExecutable;
  return {
    ...(executablePath ? { executablePath } : {}),
    args: packagedExecutable ? [] : [join(V2_ROOT, "apps/desktop/dist/main.js")],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      ...(externalExecutable ? { ZLI_RUNTIME_NODE: process.execPath } : { ZLI_RUNTIME_NODE: undefined }),
      ZLI_DATABASE_PATH: databasePath,
      ZLI_SESSION_DATA_PATH: join(root, "session"),
      ...(packagedExecutable
        ? {}
        : {
            ZLI_RENDERER_ROOT: join(V2_ROOT, "apps/desktop/renderer"),
            ZLI_SERVER_ENTRY: join(V2_ROOT, "apps/desktop/dist/server-entry.js"),
          }),
      ZLI_TEST_PROJECT_PATH: repo,
      ZLI_TEST_PROVIDER: "mock",
      ZLI_REDUCED_MOTION: "1",
      // The packaged app under test must never ask GitHub for a newer release or replace itself.
      ZLI_DISABLE_UPDATES: "1",
      ZLI_TEST_LEGACY_SNAPSHOT_PATH: options.legacySnapshotPath,
      ...options.env,
    },
  };
}

export async function launchDesktop(
  repo: string,
  root: string,
  options: DesktopLaunchOptions = {},
): Promise<DesktopFixture> {
  const command = await desktopCommand(repo, root, options);
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await launchOnce();
    } catch (error) {
      // A busy Windows runner sometimes never opens the first window, or the process exits before
      // it does. That launch is already closed, so one more start is safe. Any other failure is
      // real. The wait counts against the test, so put it back or teardown crosses the limit.
      if (!(error instanceof WindowTimeout)) throw error;
      if (attempt >= 2) throw error.cause;
      const timeout = test.info().timeout;
      if (timeout > 0) test.setTimeout(timeout + RELAUNCH_BUDGET_MS);
    }
  }

  async function launchOnce(): Promise<DesktopFixture> {
    const app = await electron.launch({
      args: command.args,
      ...(command.executablePath ? { executablePath: command.executablePath } : {}),
      env: command.env,
      timeout: WINDOW_TIMEOUT_MS,
    });
    // Taken while the connection still has the process. Once the app exits, process() throws
    // reading '_object' and that throw would replace the window error, so the retry above never runs.
    let child: ChildProcess | undefined;
    try {
      child = electronChildProcess(app);
      await app.context().addInitScript({ content: DISABLE_WEBGL });
      const page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS }).catch((error: unknown) => {
        throw new WindowTimeout(error);
      });
      // The first window can start loading before the init script is registered. When that page
      // navigates mid-call, the new page already ran the registered init script.
      await page.evaluate(DISABLE_WEBGL).catch((error: unknown) => {
        if (!(error instanceof Error && error.message.includes("Execution context was destroyed"))) throw error;
      });
      await page.waitForLoadState("domcontentloaded");
      // The app also forces reduced motion through ZLI_REDUCED_MOTION; this covers a page loaded before it applied.
      await page.emulateMedia({ reducedMotion: "reduce" });
      if (options.trustAgents !== false) {
        await page.addLocatorHandler(page.getByRole("dialog", { name: "Let agents work in this project" }), (dialog) =>
          dialog.getByRole("button", { name: "Let agents work" }).click(),
        );
      }
      const runtime = page.getByRole("status").filter({ hasText: "Runtime connected" });
      const showSidebar = page.getByRole("button", { name: "Show sidebar" });
      await runtime.or(showSidebar).first().waitFor({ state: "visible" });
      // A relaunch in the same test keeps the profile of the launch before it, which can leave the sidebar hidden.
      if (await showSidebar.isVisible()) await showSidebar.click();
      await runtime.waitFor({ state: "visible" });
      return { app, page, root, repo };
    } catch (error) {
      // A launched app that never showed its window would otherwise outlive the test and stall worker shutdown.
      await abandonLaunch(app, child);
      await stopDesktopDaemon(root).catch(() => undefined);
      throw error;
    }
  }
}

async function abandonLaunch(app: ElectronApplication, child: ChildProcess | undefined): Promise<void> {
  if (!child) {
    await app.close().catch(() => undefined);
    return;
  }
  await closeChildProcess(app.close.bind(app), child, () => terminateProcessTree(child.pid)).catch(() => undefined);
  releaseStdio(child);
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

/**
 * Shows or hides a side panel the way a person does: the open panel has its own button in the top bar,
 * and every panel is in the Tools menu.
 */
export async function togglePanel(page: Page, name: string): Promise<void> {
  const open = page.locator(".topbar-tools").getByRole("button", { name, exact: true });
  if (await open.isVisible()) {
    await open.click();
    return;
  }
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page
    .locator('[role="menu"]')
    .locator('[role="menuitem"], [role="menuitemcheckbox"]')
    .filter({ hasText: new RegExp(`^${name}`, "u") })
    .first()
    .click();
}

/**
 * Opens the New agent dialog with every option. New chat opens a chat at once, so tests that pick an agent,
 * a view, or a worktree reach the dialog the way a person does: New agent with options in the palette.
 */
export async function openNewAgentOptions(page: Page): Promise<void> {
  // A focused terminal keeps Ctrl+K for itself, and the palette hands focus back to what had it when it closes,
  // which would pull the cursor away from the agent this opens. Start from nothing focused, as after a click.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Control+K");
  await page.getByRole("textbox", { name: "Search commands" }).fill("New agent with options");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "New agent" })).toBeVisible();
}
