import { posix } from "node:path";

import {
  BROWSER_DEVICE_PRESETS,
  BrowserControlAction,
  BrowserControlClickInput,
  BrowserControlConsoleInput,
  BrowserControlEvaluateInput,
  BrowserControlFillInput,
  BrowserControlNavigateInput,
  BrowserControlOpenInput,
  BrowserControlPressInput,
  BrowserControlReloadInput,
  BrowserControlScreenshotInput,
  BrowserControlTarget,
  BrowserControlViewportInput,
  BrowserControlWaitInput,
  browserViewportForPreset,
  type BrowserTabProjection,
  type BrowserViewport,
} from "@zli-v2/contracts";

import { isAllowedBrowserNavigation } from "../security/NavigationPolicy.js";
import type { BrowserManager } from "./BrowserManager.js";

/** Agent tabs share the renderer's default profile, so they see the same cookies as the user's tabs. */
export const DEFAULT_BROWSER_PROFILE_ID = "00000000-0000-4000-8000-000000000002";

const MAX_LISTED_ENTRIES = 200;
const SETTLE_TIMEOUT_MS = 10_000;

export type BrowserControlManager = Pick<
  BrowserManager,
  | "list"
  | "create"
  | "navigate"
  | "back"
  | "forward"
  | "reload"
  | "close"
  | "snapshot"
  | "click"
  | "fill"
  | "press"
  | "waitForNetworkIdle"
  | "waitForSelector"
  | "evaluate"
  | "screenshot"
  | "consoleMessages"
  | "clearConsole"
  | "networkRequests"
  | "setViewport"
>;

export type BrowserControlWorktree = { readonly worktreeId: string; readonly path: string; readonly status: string };

export type BrowserControlHost = {
  manager(): BrowserControlManager | undefined;
  worktrees(): readonly BrowserControlWorktree[];
  reveal(event: { browserTabId: string; worktreeId: string }): void;
  readonly platform?: NodeJS.Platform;
  /** How long open and navigate wait for the page before returning with status "loading". */
  readonly loadTimeoutMs?: number;
};

export class BrowserControlError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "BrowserControlError";
  }
}

export type BrowserControlDispatch = (action: string, input: unknown) => Promise<unknown>;

type TabSummary = {
  browserTabId: string;
  url: string;
  title: string;
  status: BrowserTabProjection["status"];
  active: boolean;
  agentOpened: boolean;
  loadError?: string;
  viewport?: BrowserViewport;
};

export function createBrowserControlActions(host: BrowserControlHost): BrowserControlDispatch {
  const platform = host.platform ?? process.platform;
  const loadTimeoutMs = host.loadTimeoutMs ?? 20_000;
  const agentTabs = new Set<string>();
  const lastUsed = new Map<string, string>();

  const requireManager = (): BrowserControlManager => {
    const manager = host.manager();
    if (!manager) throw new BrowserControlError("ZLI's browser is still starting. Try again in a moment.", 503);
    return manager;
  };

  const summarize = (tab: BrowserTabProjection): TabSummary => ({
    browserTabId: tab.browserTabId,
    url: tab.url,
    title: tab.title,
    status: tab.status,
    active: tab.active,
    agentOpened: agentTabs.has(tab.browserTabId),
    ...(tab.loadError ? { loadError: tab.loadError } : {}),
    ...(tab.viewport ? { viewport: tab.viewport } : {}),
  });

  const current = (manager: BrowserControlManager, browserTabId: string): BrowserTabProjection => {
    const tab = manager.list().find((candidate) => candidate.browserTabId === browserTabId);
    if (!tab) throw new BrowserControlError("The browser tab was closed.", 404);
    return tab;
  };

  const pickTab = (
    manager: BrowserControlManager,
    worktreeId: string,
    browserTabId: string | undefined,
  ): BrowserTabProjection => {
    const tabs = manager.list(worktreeId);
    if (browserTabId) {
      const explicit = tabs.find((tab) => tab.browserTabId === browserTabId);
      if (!explicit) throw new BrowserControlError(`This worktree has no browser tab ${browserTabId}.`, 404);
      return explicit;
    }
    const recent = tabs.find((tab) => tab.browserTabId === lastUsed.get(worktreeId));
    const chosen =
      recent ??
      [...tabs].reverse().find((tab) => agentTabs.has(tab.browserTabId)) ??
      tabs.find((tab) => tab.active) ??
      tabs.at(-1);
    if (!chosen)
      throw new BrowserControlError(
        "No browser tab is open for this worktree. Open one with browser_open and a URL first.",
        404,
      );
    return chosen;
  };

  const target = (input: BrowserControlTarget) => {
    const manager = requireManager();
    const worktree = resolveBrowserControlWorktree(input, host.worktrees(), platform);
    const tab = pickTab(manager, worktree.worktreeId, input.browserTabId);
    lastUsed.set(worktree.worktreeId, tab.browserTabId);
    return { manager, worktree, tab, browserTabId: tab.browserTabId };
  };

  const navigateBounded = async (manager: BrowserControlManager, browserTabId: string, url: string) => {
    // loadURL resolves at did-finish-load, slightly before did-stop-loading marks the tab idle.
    const navigation = manager
      .navigate({ browserTabId, url })
      .then(() => settle(manager, browserTabId, 0))
      .then(() => true);
    navigation.catch(() => undefined);
    return Promise.race([navigation, delay(loadTimeoutMs).then(() => false)]);
  };

  /** Waits for the tab to leave "loading"; after input, first gives a navigation time to begin. */
  const settle = async (manager: BrowserControlManager, browserTabId: string, startDelayMs = 150) => {
    if (startDelayMs > 0) await delay(startDelayMs);
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const tab = manager.list().find((candidate) => candidate.browserTabId === browserTabId);
      if (tab?.status !== "loading") return;
      await delay(100);
    }
  };

  const actions: Record<BrowserControlAction, (input: unknown) => Promise<unknown>> = {
    ping: async () => ({ pid: process.pid, ready: host.manager() !== undefined }),

    tabs: async (input) => {
      const parsed = BrowserControlTarget.parse(input);
      const manager = requireManager();
      const worktree = resolveBrowserControlWorktree(parsed, host.worktrees(), platform);
      const tabs = manager.list(worktree.worktreeId);
      const preferred = tabs.length > 0 ? pickTab(manager, worktree.worktreeId, undefined).browserTabId : undefined;
      return {
        worktreeId: worktree.worktreeId,
        worktreePath: worktree.path,
        tabs: tabs.map((tab) => ({ ...summarize(tab), default: tab.browserTabId === preferred })),
      };
    },

    open: async (input) => {
      const parsed = BrowserControlOpenInput.parse(input);
      const manager = requireManager();
      const worktree = resolveBrowserControlWorktree(parsed, host.worktrees(), platform);
      const url = normalizeAgentUrl(parsed.url);
      const tabs = manager.list(worktree.worktreeId);
      let tab: BrowserTabProjection | undefined;
      if (parsed.browserTabId) tab = pickTab(manager, worktree.worktreeId, parsed.browserTabId);
      else if (!parsed.newTab) {
        const recent = tabs.find(
          (candidate) =>
            candidate.browserTabId === lastUsed.get(worktree.worktreeId) && agentTabs.has(candidate.browserTabId),
        );
        tab = recent ?? [...tabs].reverse().find((candidate) => agentTabs.has(candidate.browserTabId));
      }
      if (!tab) {
        tab = await manager.create({
          worktreeId: worktree.worktreeId,
          profileId: DEFAULT_BROWSER_PROFILE_ID,
          url: "about:blank",
        });
        agentTabs.add(tab.browserTabId);
      }
      const browserTabId = tab.browserTabId;
      lastUsed.set(worktree.worktreeId, browserTabId);
      const loaded = await navigateBounded(manager, browserTabId, url);
      host.reveal({ browserTabId, worktreeId: worktree.worktreeId });
      return { tab: summarize(current(manager, browserTabId)), loaded, revealed: true };
    },

    navigate: async (input) => {
      const parsed = BrowserControlNavigateInput.parse(input);
      const url = normalizeAgentUrl(parsed.url);
      const { manager, browserTabId } = target(parsed);
      const loaded = await navigateBounded(manager, browserTabId, url);
      return { tab: summarize(current(manager, browserTabId)), loaded };
    },

    back: async (input) => {
      const { manager, browserTabId } = target(BrowserControlTarget.parse(input));
      if (!manager.back(browserTabId)) throw new BrowserControlError("There is no earlier page in this tab's history.");
      await settle(manager, browserTabId);
      return { tab: summarize(current(manager, browserTabId)) };
    },

    forward: async (input) => {
      const { manager, browserTabId } = target(BrowserControlTarget.parse(input));
      if (!manager.forward(browserTabId))
        throw new BrowserControlError("There is no later page in this tab's history.");
      await settle(manager, browserTabId);
      return { tab: summarize(current(manager, browserTabId)) };
    },

    reload: async (input) => {
      const parsed = BrowserControlReloadInput.parse(input);
      const { manager, browserTabId } = target(parsed);
      manager.reload(browserTabId, parsed.hard ?? false);
      await settle(manager, browserTabId);
      return { tab: summarize(current(manager, browserTabId)) };
    },

    close: async (input) => {
      const { manager, worktree, browserTabId } = target(BrowserControlTarget.parse(input));
      manager.close(browserTabId);
      agentTabs.delete(browserTabId);
      if (lastUsed.get(worktree.worktreeId) === browserTabId) lastUsed.delete(worktree.worktreeId);
      return { closed: browserTabId };
    },

    snapshot: async (input) => {
      const { manager, browserTabId } = target(BrowserControlTarget.parse(input));
      return { browserTabId, ...(await manager.snapshot(browserTabId)) };
    },

    click: async (input) => {
      const parsed = BrowserControlClickInput.parse(input);
      const { manager, browserTabId } = target(parsed);
      const by =
        parsed.selector !== undefined
          ? { selector: parsed.selector }
          : parsed.text !== undefined
            ? { text: parsed.text }
            : { x: parsed.x ?? 0, y: parsed.y ?? 0 };
      const clicked = await manager.click(browserTabId, by);
      await settle(manager, browserTabId);
      const tab = current(manager, browserTabId);
      return { browserTabId, clicked, url: tab.url, title: tab.title };
    },

    fill: async (input) => {
      const parsed = BrowserControlFillInput.parse(input);
      const { manager, browserTabId } = target(parsed);
      await manager.fill(browserTabId, { selector: parsed.selector, value: parsed.value });
      return { browserTabId, filled: parsed.selector };
    },

    press: async (input) => {
      const parsed = BrowserControlPressInput.parse(input);
      const { manager, browserTabId } = target(parsed);
      await manager.press(browserTabId, { key: parsed.key });
      await settle(manager, browserTabId);
      const tab = current(manager, browserTabId);
      return { browserTabId, pressed: parsed.key, url: tab.url, title: tab.title };
    },

    wait: async (input) => {
      const parsed = BrowserControlWaitInput.parse(input);
      const { manager, browserTabId } = target(parsed);
      const started = Date.now();
      if (parsed.selector !== undefined) {
        const result = await manager.waitForSelector(browserTabId, parsed.selector, {
          ...(parsed.timeoutMs === undefined ? {} : { timeoutMs: parsed.timeoutMs }),
        });
        return { browserTabId, selector: parsed.selector, ...result, elapsedMs: Date.now() - started };
      }
      const result = await manager.waitForNetworkIdle(browserTabId, {
        ...(parsed.idleMs === undefined ? {} : { idleMs: parsed.idleMs }),
        ...(parsed.timeoutMs === undefined ? {} : { timeoutMs: parsed.timeoutMs }),
      });
      return { browserTabId, ...result, elapsedMs: Date.now() - started };
    },

    evaluate: async (input) => {
      const parsed = BrowserControlEvaluateInput.parse(input);
      const { manager, browserTabId } = target(parsed);
      const result = await manager.evaluate(browserTabId, parsed.expression, {
        ...(parsed.timeoutMs === undefined ? {} : { timeoutMs: parsed.timeoutMs }),
      });
      return { browserTabId, ...result };
    },

    console: async (input) => {
      const parsed = BrowserControlConsoleInput.parse(input);
      const { manager, browserTabId } = target(parsed);
      const messages = manager.consoleMessages(browserTabId);
      if (parsed.clear) manager.clearConsole(browserTabId);
      return {
        browserTabId,
        total: messages.length,
        messages: messages.slice(-MAX_LISTED_ENTRIES),
        ...(parsed.clear ? { cleared: true } : {}),
      };
    },

    network: async (input) => {
      const { manager, browserTabId } = target(BrowserControlTarget.parse(input));
      const requests = manager.networkRequests(browserTabId);
      return { browserTabId, total: requests.length, requests: requests.slice(-MAX_LISTED_ENTRIES) };
    },

    screenshot: async (input) => {
      const parsed = BrowserControlScreenshotInput.parse(input);
      const { manager, browserTabId } = target(parsed);
      const screenshot = await manager.screenshot(browserTabId, {
        ...(parsed.format === undefined ? {} : { format: parsed.format }),
        ...(parsed.fullPage ? { fullPage: true } : {}),
      });
      const tab = current(manager, browserTabId);
      return {
        browserTabId,
        url: tab.url,
        title: tab.title,
        ...screenshot,
        ...(screenshot.mimeType === "image/png" ? pngSize(screenshot.data) : {}),
      };
    },

    viewport: async (input) => {
      const parsed = BrowserControlViewportInput.parse(input);
      const { manager, browserTabId } = target(parsed);
      const viewport = viewportFromInput(parsed);
      const tab = await manager.setViewport(browserTabId, viewport);
      return { tab: summarize(tab) };
    },
  };

  return async (action, input) => {
    const parsedAction = BrowserControlAction.safeParse(action);
    if (!parsedAction.success) throw new BrowserControlError(`Unknown browser action: ${action}`, 404);
    return actions[parsedAction.data](input ?? {});
  };
}

export function resolveBrowserControlWorktree(
  input: BrowserControlTarget,
  worktrees: readonly BrowserControlWorktree[],
  platform: NodeJS.Platform = process.platform,
): BrowserControlWorktree {
  const ready = worktrees.filter((worktree) => worktree.status === "ready");
  if (input.worktreeId) {
    const explicit = ready.find((worktree) => worktree.worktreeId === input.worktreeId);
    if (!explicit) throw new BrowserControlError(`ZLI has no ready worktree with id ${input.worktreeId}.`, 404);
    return explicit;
  }
  if (input.defaultWorktreeId) {
    const fromEnvironment = ready.find((worktree) => worktree.worktreeId === input.defaultWorktreeId);
    if (fromEnvironment) return fromEnvironment;
  }
  if (input.cwd) {
    const cwd = normalizeWorktreePath(input.cwd, platform);
    let best: { worktree: BrowserControlWorktree; length: number } | undefined;
    for (const worktree of ready) {
      const root = normalizeWorktreePath(worktree.path, platform);
      if (cwd !== root && !cwd.startsWith(root.endsWith("/") ? root : `${root}/`)) continue;
      if (!best || root.length > best.length) best = { worktree, length: root.length };
    }
    if (best) return best.worktree;
  }
  throw new BrowserControlError("Could not tell which ZLI worktree this agent is working in. Pass cwd.");
}

/** Compares paths the way the host filesystem does; Git Bash paths such as /c/work map to c:/work. */
export function normalizeWorktreePath(value: string, platform: NodeJS.Platform = process.platform): string {
  let path = value.trim().replaceAll("\\", "/");
  if (platform === "win32") {
    const msys = /^\/([a-z])(?=\/|$)/iu.exec(path);
    if (msys) path = `${msys[1]}:${path.slice(2) || "/"}`;
    path = path.toLowerCase();
  }
  path = posix.normalize(path);
  return path.length > 1 && path.endsWith("/") && !/^[a-z]:\/$/iu.test(path) ? path.slice(0, -1) : path;
}

export function normalizeAgentUrl(value: string): string {
  const trimmed = value.trim();
  const hasScheme =
    /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed) ||
    /^(about|javascript|data|file|blob|view-source|mailto):/iu.test(trimmed);
  const url = hasScheme ? trimmed : `http://${trimmed}`;
  if (!isAllowedBrowserNavigation(url))
    throw new BrowserControlError("Only http(s) URLs and about:blank can be opened in the ZLI browser.");
  return url;
}

function viewportFromInput(input: BrowserControlViewportInput): BrowserViewport | null {
  if (input.reset) return null;
  if (input.preset !== undefined) {
    const preset = browserViewportForPreset(input.preset);
    if (!preset)
      throw new BrowserControlError(
        `Unknown device preset ${input.preset}. Use one of: ${BROWSER_DEVICE_PRESETS.map((candidate) => candidate.id).join(", ")}.`,
      );
    return preset;
  }
  if (input.width === undefined || input.height === undefined)
    throw new BrowserControlError("Pass a preset, both width and height, or reset: true.");
  return {
    width: input.width,
    height: input.height,
    mobile: input.mobile ?? false,
    ...(input.deviceScaleFactor === undefined ? {} : { deviceScaleFactor: input.deviceScaleFactor }),
  };
}

function pngSize(data: string): { width: number; height: number } | Record<string, never> {
  const header = Buffer.from(data.slice(0, 44), "base64");
  if (header.length < 24 || header.toString("latin1", 12, 16) !== "IHDR") return {};
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
