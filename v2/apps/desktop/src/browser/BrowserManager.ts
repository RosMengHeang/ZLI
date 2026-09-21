import { randomUUID } from "node:crypto";

import {
  BrowserBounds,
  BrowserNavigateInput,
  BrowserTabCreateInput,
  BrowserTabId,
  BrowserTabProjection,
  type BrowserTabProjection as BrowserTabProjectionValue,
  type BrowserBounds as BrowserBoundsValue,
} from "@zli-v2/contracts";

import {
  BrowserAutomation,
  type BrowserInspection,
  type BrowserScreenshot,
  type BrowserScreenshotOptions,
  type BrowserSnapshot,
  type CdpClientLike,
} from "./BrowserAutomation.js";
import { BrowserSessionManager, type BrowserSessionModule } from "./BrowserSession.js";
import { DesignMode, type DesignInspection } from "./DesignMode.js";
import { isAllowedBrowserNavigation } from "../security/NavigationPolicy.js";

export type BrowserWebContentsLike = {
  getURL(): string;
  getTitle(): string;
  loadURL(url: string): Promise<void>;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  reloadIgnoringCache(): void;
  stop(): void;
  setWindowOpenHandler?(handler: (details: { url: string }) => { action: "deny" }): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
  isDestroyed(): boolean;
  destroy?(): void;
  openDevTools?(): void;
};

export type BrowserViewLike = {
  webContents: BrowserWebContentsLike;
  setBounds(bounds: BrowserBoundsValue): void;
  setVisible(visible: boolean): void;
};

export type BrowserViewFactory = {
  create(options: { partition: string; session?: unknown }): BrowserViewLike;
};

export type BrowserViewHost = {
  addChildView(view: BrowserViewLike): void;
  removeChildView(view: BrowserViewLike): void;
};

export type BrowserManagerOptions = {
  readonly sessionManager?: BrowserSessionManager;
  readonly sessionModule?: BrowserSessionModule;
  readonly defaultBounds?: BrowserBoundsValue;
  readonly automationFactory?: (view: BrowserViewLike) => { cdp: CdpClientLike; automation: BrowserAutomation; designMode: DesignMode };
};

type ManagedTab = {
  readonly view: BrowserViewLike;
  projection: BrowserTabProjectionValue;
  bounds: BrowserBoundsValue;
  automation?: BrowserAutomation;
  designMode?: DesignMode;
};

const DEFAULT_BOUNDS: BrowserBoundsValue = { x: 0, y: 0, width: 1024, height: 720 };

export class BrowserManager {
  readonly #tabs = new Map<string, ManagedTab>();
  readonly #listeners = new Set<(tab: BrowserTabProjectionValue) => void>();
  readonly #sessionManager: BrowserSessionManager;
  readonly #sessionModule: BrowserSessionModule | undefined;
  readonly #defaultBounds: BrowserBoundsValue;
  readonly #automationFactory: BrowserManagerOptions["automationFactory"];

  constructor(
    private readonly factory: BrowserViewFactory,
    private readonly host: BrowserViewHost,
    options: BrowserManagerOptions = {},
  ) {
    this.#sessionManager = options.sessionManager ?? new BrowserSessionManager();
    this.#sessionModule = options.sessionModule;
    this.#defaultBounds = options.defaultBounds ?? DEFAULT_BOUNDS;
    this.#automationFactory = options.automationFactory;
  }

  async create(input: unknown): Promise<BrowserTabProjectionValue> {
    const parsed = BrowserTabCreateInput.parse(input);
    assertBrowserUrl(parsed.url);
    const browserTabId = BrowserTabId.parse(randomUUID());
    const partition = this.#sessionManager.partitionFor(parsed.worktreeId, parsed.profileId);
    const browserSession = this.#sessionModule
      ? this.#sessionManager.getSession(this.#sessionModule, parsed.worktreeId, parsed.profileId)
      : undefined;
    const view = this.factory.create({ partition, ...(browserSession ? { session: browserSession } : {}) });
    const bounds = parsed.bounds ?? this.#defaultBounds;
    view.setBounds(bounds);
    view.setVisible(false);
    this.host.addChildView(view);
    const projection = BrowserTabProjection.parse({
      browserTabId,
      profileId: parsed.profileId,
      worktreeId: parsed.worktreeId,
      url: parsed.url,
      title: "",
      active: false,
      status: "loading",
    });
    const automation = this.#automationFactory?.(view);
    const tab: ManagedTab = {
      view,
      projection,
      bounds,
      ...(automation ? { automation: automation.automation, designMode: automation.designMode } : {}),
    };
    this.#tabs.set(browserTabId, tab);
    this.#installObservers(browserTabId, tab);
    await view.webContents.loadURL(parsed.url);
    this.#publish(tab.projection);
    return tab.projection;
  }

  list(worktreeId?: string): BrowserTabProjectionValue[] {
    return [...this.#tabs.values()]
      .map((tab) => tab.projection)
      .filter((tab) => worktreeId === undefined || tab.worktreeId === worktreeId);
  }

  subscribe(listener: (tab: BrowserTabProjectionValue) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async activate(browserTabId: string): Promise<BrowserTabProjectionValue> {
    const target = this.#require(browserTabId);
    for (const [tabId, tab] of this.#tabs) {
      const active = tabId === browserTabId;
      tab.view.setVisible(active);
      this.#replace(tabId, { active });
    }
    return target.projection;
  }

  async setBounds(browserTabId: string, input: unknown): Promise<void> {
    const tab = this.#require(browserTabId);
    const bounds = BrowserBounds.parse(input);
    tab.bounds = bounds;
    tab.view.setBounds(bounds);
  }

  async navigate(input: unknown): Promise<BrowserTabProjectionValue> {
    const parsed = BrowserNavigateInput.parse(input);
    assertBrowserUrl(parsed.url);
    const tab = this.#require(parsed.browserTabId);
    this.#replace(parsed.browserTabId, { url: parsed.url, status: "loading" });
    await tab.view.webContents.loadURL(parsed.url);
    return tab.projection;
  }

  back(browserTabId: string): void { this.#require(browserTabId).view.webContents.goBack(); }
  forward(browserTabId: string): void { this.#require(browserTabId).view.webContents.goForward(); }
  reload(browserTabId: string, hard = false): void {
    const contents = this.#require(browserTabId).view.webContents;
    if (hard) contents.reloadIgnoringCache(); else contents.reload();
  }
  stop(browserTabId: string): void { this.#require(browserTabId).view.webContents.stop(); }
  openDevTools(browserTabId: string): void { this.#require(browserTabId).view.webContents.openDevTools?.(); }

  async snapshot(browserTabId: string): Promise<BrowserSnapshot> { return this.#automation(browserTabId).snapshot(); }
  async click(browserTabId: string, input: { selector: string } | { x: number; y: number }): Promise<void> { return this.#automation(browserTabId).click(input); }
  async fill(browserTabId: string, input: { selector: string; value: string }): Promise<void> { return this.#automation(browserTabId).fill(input); }
  async press(browserTabId: string, input: { key: string }): Promise<void> { return this.#automation(browserTabId).press(input); }
  async waitForNetworkIdle(browserTabId: string, options: { idleMs?: number; timeoutMs?: number }): Promise<{ idle: boolean }> {
    return this.#automation(browserTabId).waitForNetworkIdle(options);
  }
  async screenshot(browserTabId: string, options: BrowserScreenshotOptions): Promise<BrowserScreenshot> {
    return this.#automation(browserTabId).screenshot(options);
  }
  async inspectElement(browserTabId: string, input: { selector: string }): Promise<BrowserInspection> {
    return this.#automation(browserTabId).inspectElement(input);
  }
  async designInspect(browserTabId: string, input: { selector: string }): Promise<DesignInspection> {
    const tab = this.#require(browserTabId);
    if (!tab.designMode) throw new Error("Browser automation is not available for this tab.");
    return tab.designMode.inspect(input);
  }
  consoleEntries(browserTabId: string): readonly unknown[] { return this.#automation(browserTabId).consoleEntries(); }
  networkEntries(browserTabId: string): readonly unknown[] { return this.#automation(browserTabId).networkEntries(); }

  close(browserTabId: string): void {
    const tab = this.#require(browserTabId);
    this.host.removeChildView(tab.view);
    tab.automation?.dispose();
    tab.view.webContents.destroy?.();
    this.#tabs.delete(browserTabId);
  }

  closeAll(): void {
    for (const browserTabId of [...this.#tabs.keys()]) this.close(browserTabId);
  }

  #installObservers(browserTabId: string, tab: ManagedTab): void {
    const contents = tab.view.webContents;
    contents.setWindowOpenHandler?.(({ url }) => {
      if (isAllowedBrowserNavigation(url)) {
        void this.create({
          worktreeId: tab.projection.worktreeId,
          profileId: tab.projection.profileId,
          url,
          bounds: tab.bounds,
        }).then((created) => this.activate(created.browserTabId)).catch(() => undefined);
      }
      return { action: "deny" };
    });
    contents.on("will-navigate", (event, url) => {
      if (isRecordWithPreventDefault(event) && typeof url === "string" && !isAllowedBrowserNavigation(url)) event.preventDefault();
    });
    contents.on("did-start-loading", () => this.#replace(browserTabId, { status: "loading" }));
    contents.on("did-stop-loading", () => {
      if (contents.isDestroyed()) return;
      this.#replace(browserTabId, {
        status: "idle",
        url: safeCurrentUrl(contents, tab.projection.url),
        title: safeTitle(contents, tab.projection.title),
      });
    });
    contents.on("page-title-updated", (_event, title) => {
      if (typeof title === "string") this.#replace(browserTabId, { title });
    });
    contents.on("did-navigate", (_event, url) => {
      if (typeof url === "string" && isAllowedBrowserNavigation(url)) this.#replace(browserTabId, { url });
    });
    contents.on("did-fail-load", (_event, _code, _description, url) => {
      this.#replace(browserTabId, {
        status: "crashed",
        ...(typeof url === "string" ? { url } : {}),
      });
    });
    contents.on("render-process-gone", () => this.#replace(browserTabId, { status: "crashed" }));
  }

  #replace(browserTabId: string, patch: Partial<BrowserTabProjectionValue>): void {
    const current = this.#require(browserTabId);
    current.projection = BrowserTabProjection.parse({ ...current.projection, ...patch });
    this.#publish(current.projection);
  }

  #publish(tab: BrowserTabProjectionValue): void {
    for (const listener of this.#listeners) listener(tab);
  }

  #require(browserTabId: string): ManagedTab {
    const tab = this.#tabs.get(browserTabId);
    if (!tab) throw new Error(`Unknown browser tab: ${browserTabId}`);
    return tab;
  }

  #automation(browserTabId: string): BrowserAutomation {
    const automation = this.#require(browserTabId).automation;
    if (!automation) throw new Error("Browser automation is not available for this tab.");
    return automation;
  }
}

function assertBrowserUrl(url: string): void {
  if (!isAllowedBrowserNavigation(url)) throw new Error("Invalid browser URL: only http(s) navigation is allowed.");
}

function safeCurrentUrl(contents: BrowserWebContentsLike, fallback: string): string {
  try {
    const url = contents.getURL();
    return isAllowedBrowserNavigation(url) ? url : fallback;
  } catch {
    return fallback;
  }
}

function safeTitle(contents: BrowserWebContentsLike, fallback: string): string {
  try { return contents.getTitle().slice(0, 512); } catch { return fallback; }
}

function isRecordWithPreventDefault(value: unknown): value is { preventDefault(): void } {
  return typeof value === "object" && value !== null && "preventDefault" in value && typeof value.preventDefault === "function";
}
