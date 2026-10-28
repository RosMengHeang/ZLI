import { randomUUID } from "node:crypto";

import {
  BrowserBounds,
  BrowserNavigateInput,
  BrowserTabCreateInput,
  BrowserTabId,
  BrowserTabProjection,
  BrowserViewport,
  type BrowserTabProjection as BrowserTabProjectionValue,
  type BrowserBounds as BrowserBoundsValue,
  type BrowserViewport as BrowserViewportValue,
} from "@zli-v2/contracts";

import type {
  BrowserAutomation,
  BrowserClickInput,
  BrowserClickResult,
  BrowserConsoleMessage,
  BrowserEmulation,
  BrowserEvaluateResult,
  BrowserInspection,
  BrowserNetworkRequest,
  BrowserScreenshot,
  BrowserScreenshotOptions,
  BrowserSnapshot,
  CdpClientLike,
} from "./BrowserAutomation.js";
import { BrowserSessionManager, type BrowserSessionModule } from "./BrowserSession.js";
import type { DesignMode, DesignInspection } from "./DesignMode.js";
import type { DesignMark, DesignPickResult, DesignPreview, DesignRect, DesignStroke } from "./DesignPicker.js";
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
  openDevTools?(options?: { mode: "detach"; activate?: boolean }): void;
  isDevToolsOpened?(): boolean;
  readonly devToolsWebContents?: { focus(): void } | null;
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
  readonly automationFactory?: (view: BrowserViewLike) => {
    cdp: CdpClientLike;
    automation: BrowserAutomation;
    designMode: DesignMode;
  };
  readonly onProjection?: (tab: BrowserTabProjectionValue) => void;
  readonly onClose?: (tab: BrowserTabProjectionValue) => void;
};

type ProjectionPatch = { [Key in keyof BrowserTabProjectionValue]?: BrowserTabProjectionValue[Key] | undefined };

type ManagedTab = {
  view: BrowserViewLike;
  projection: BrowserTabProjectionValue;
  /** The pane surface the renderer reported. With a viewport the native view is fitted inside it. */
  bounds: BrowserBoundsValue;
  /** The scale last sent to Chromium, so layout passes only re-emulate when it changes. */
  emulatedScale?: number | undefined;
  automation?: BrowserAutomation | undefined;
  designMode?: DesignMode | undefined;
  recoveryAttempted?: boolean;
};

const DEFAULT_BOUNDS: BrowserBoundsValue = { x: 0, y: 0, width: 1024, height: 720 };
const AUTOMATION_START_TIMEOUT_MS = 3_000;

export class BrowserManager {
  readonly #tabs = new Map<string, ManagedTab>();
  readonly #listeners = new Set<(tab: BrowserTabProjectionValue) => void>();
  readonly #sessionManager: BrowserSessionManager;
  readonly #sessionModule: BrowserSessionModule | undefined;
  readonly #defaultBounds: BrowserBoundsValue;
  readonly #automationFactory: BrowserManagerOptions["automationFactory"];
  readonly #onProjection: BrowserManagerOptions["onProjection"];
  readonly #onClose: BrowserManagerOptions["onClose"];
  #hidden = false;
  #lastSurface: BrowserBoundsValue | undefined;

  constructor(
    private readonly factory: BrowserViewFactory,
    private readonly host: BrowserViewHost,
    options: BrowserManagerOptions = {},
  ) {
    this.#sessionManager = options.sessionManager ?? new BrowserSessionManager();
    this.#sessionModule = options.sessionModule;
    this.#defaultBounds = options.defaultBounds ?? DEFAULT_BOUNDS;
    this.#automationFactory = options.automationFactory;
    this.#onProjection = options.onProjection;
    this.#onClose = options.onClose;
  }

  async create(input: unknown): Promise<BrowserTabProjectionValue> {
    const parsed = BrowserTabCreateInput.parse(input);
    assertBrowserUrl(parsed.url);
    const browserTabId = parsed.browserTabId ?? BrowserTabId.parse(randomUUID());
    const existing = this.#tabs.get(browserTabId);
    if (existing) {
      await this.activate(browserTabId);
      return existing.projection;
    }
    const partition = this.#sessionManager.partitionFor(parsed.worktreeId, parsed.profileId);
    const browserSession = this.#sessionModule
      ? this.#sessionManager.getSession(this.#sessionModule, parsed.worktreeId, parsed.profileId)
      : undefined;
    const view = this.factory.create({ partition, ...(browserSession ? { session: browserSession } : {}) });
    const bounds = parsed.bounds ?? this.#lastSurface ?? this.#defaultBounds;
    let attached = false;
    let tab: ManagedTab;
    try {
      view.setBounds(bounds);
      view.setVisible(false);
      this.host.addChildView(view);
      attached = true;
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
      tab = {
        view,
        projection,
        bounds,
        ...(automation ? { automation: automation.automation, designMode: automation.designMode } : {}),
      };
      this.#tabs.set(browserTabId, tab);
      this.#installObservers(browserTabId, tab);
    } catch (cause) {
      this.#tabs.delete(browserTabId);
      if (attached) this.host.removeChildView(view);
      view.webContents.destroy?.();
      throw cause;
    }
    // A failed page load (for example a dev server that is not running yet) must not orphan the
    // view: the tab stays registered and reports the failure through its projection.
    await this.#load(browserTabId, tab, parsed.url);
    // CDP domain enables hang on a view that has no renderer yet, so automation starts after the
    // first load; later navigations are then recorded from their first request.
    if (this.#tabs.get(browserTabId) === tab) await this.#startAutomation(tab);
    if (this.#tabs.get(browserTabId) === tab) this.#publish(tab.projection);
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
    this.#require(browserTabId);
    this.#hidden = false;
    return this.#select(browserTabId);
  }

  /** Hides every native view, for example while the renderer shows a dialog or another tool pane. */
  hide(): void {
    this.#hidden = true;
    for (const tab of this.#tabs.values()) tab.view.setVisible(false);
  }

  get hidden(): boolean {
    return this.#hidden;
  }

  #select(browserTabId: string): BrowserTabProjectionValue {
    const target = this.#require(browserTabId);
    for (const [tabId, tab] of this.#tabs) {
      const active = tabId === browserTabId;
      tab.view.setVisible(active && !this.#hidden);
      if (tab.projection.active !== active) this.#replace(tabId, { active });
    }
    return target.projection;
  }

  async setBounds(browserTabId: string, input: unknown): Promise<void> {
    const tab = this.#require(browserTabId);
    const bounds = BrowserBounds.parse(input);
    tab.bounds = bounds;
    this.#lastSurface = bounds;
    await this.#layout(tab);
  }

  /** Emulates a device screen, or restores the pane-filling desktop view when `viewport` is null. */
  async setViewport(browserTabId: string, input: unknown): Promise<BrowserTabProjectionValue> {
    const tab = this.#require(browserTabId);
    const viewport = BrowserViewport.nullable().parse(input);
    tab.emulatedScale = undefined;
    this.#replace(browserTabId, { viewport: viewport ?? undefined });
    if (!viewport) {
      tab.view.setBounds(tab.bounds);
      await tab.automation?.emulate(null);
      return tab.projection;
    }
    await this.#layout(tab);
    return tab.projection;
  }

  async navigate(input: unknown): Promise<BrowserTabProjectionValue> {
    const parsed = BrowserNavigateInput.parse(input);
    assertBrowserUrl(parsed.url);
    const tab = this.#require(parsed.browserTabId);
    this.#replace(parsed.browserTabId, { url: parsed.url, status: "loading", loadError: undefined });
    await this.#load(parsed.browserTabId, tab, parsed.url);
    return tab.projection;
  }

  /** Returns false when there is no earlier page to go back to. */
  back(browserTabId: string): boolean {
    const contents = this.#require(browserTabId).view.webContents;
    if (!contents.canGoBack()) return false;
    contents.goBack();
    return true;
  }
  forward(browserTabId: string): boolean {
    const contents = this.#require(browserTabId).view.webContents;
    if (!contents.canGoForward()) return false;
    contents.goForward();
    return true;
  }
  reload(browserTabId: string, hard = false): void {
    const contents = this.#require(browserTabId).view.webContents;
    if (hard) contents.reloadIgnoringCache();
    else contents.reload();
  }
  stop(browserTabId: string): void {
    this.#require(browserTabId).view.webContents.stop();
  }
  /** Opens DevTools in its own window, or brings that window forward when it is already open. */
  openDevTools(browserTabId: string): void {
    const contents = this.#require(browserTabId).view.webContents;
    if (contents.isDevToolsOpened?.()) {
      contents.devToolsWebContents?.focus();
      return;
    }
    contents.openDevTools?.({ mode: "detach", activate: true });
  }

  async snapshot(browserTabId: string): Promise<BrowserSnapshot> {
    return this.#automation(browserTabId).snapshot();
  }
  async click(browserTabId: string, input: BrowserClickInput): Promise<BrowserClickResult> {
    return this.#automation(browserTabId).click(input);
  }
  async fill(browserTabId: string, input: { selector: string; value: string }): Promise<void> {
    return this.#automation(browserTabId).fill(input);
  }
  async press(browserTabId: string, input: { key: string }): Promise<void> {
    return this.#automation(browserTabId).press(input);
  }
  async waitForNetworkIdle(
    browserTabId: string,
    options: { idleMs?: number; timeoutMs?: number },
  ): Promise<{ idle: boolean }> {
    return this.#automation(browserTabId).waitForNetworkIdle(options);
  }
  async waitForSelector(browserTabId: string, selector: string, options: { timeoutMs?: number }) {
    return this.#automation(browserTabId).waitForSelector(selector, options);
  }
  async evaluate(
    browserTabId: string,
    expression: string,
    options: { timeoutMs?: number } = {},
  ): Promise<BrowserEvaluateResult> {
    return this.#automation(browserTabId).evaluate(expression, options);
  }
  async screenshot(browserTabId: string, options: BrowserScreenshotOptions): Promise<BrowserScreenshot> {
    return this.#automation(browserTabId).screenshot(options);
  }
  async inspectElement(browserTabId: string, input: { selector: string }): Promise<BrowserInspection> {
    return this.#automation(browserTabId).inspectElement(input);
  }
  async designInspect(browserTabId: string, input: { selector: string }): Promise<DesignInspection> {
    return this.#designMode(browserTabId).inspect(input);
  }
  async designPick(browserTabId: string): Promise<DesignPickResult | null> {
    return this.#designMode(browserTabId).pick();
  }
  async designCancel(browserTabId: string): Promise<void> {
    return this.#designMode(browserTabId).cancelPick();
  }
  async designMark(browserTabId: string, marks: readonly DesignMark[]): Promise<void> {
    return this.#designMode(browserTabId).mark(marks);
  }
  async designCapture(browserTabId: string, region: { bounds: DesignRect; strokes: DesignStroke[] }) {
    return this.#designMode(browserTabId).captureRegion(region);
  }
  async designPreview(browserTabId: string, input: { selector: string; preview: DesignPreview }): Promise<boolean> {
    return this.#designMode(browserTabId).preview(input);
  }
  #designMode(browserTabId: string): DesignMode {
    const tab = this.#require(browserTabId);
    if (!tab.designMode) throw new Error("Browser automation is not available for this tab.");
    return tab.designMode;
  }
  consoleEntries(browserTabId: string): readonly unknown[] {
    return this.#automation(browserTabId).consoleEntries();
  }
  networkEntries(browserTabId: string): readonly unknown[] {
    return this.#automation(browserTabId).networkEntries();
  }
  consoleMessages(browserTabId: string): readonly BrowserConsoleMessage[] {
    return this.#automation(browserTabId).consoleMessages();
  }
  clearConsole(browserTabId: string): void {
    this.#automation(browserTabId).clearConsole();
  }
  networkRequests(browserTabId: string): readonly BrowserNetworkRequest[] {
    return this.#automation(browserTabId).networkRequests();
  }

  close(browserTabId: string, options: { persist?: boolean } = {}): void {
    const tab = this.#require(browserTabId);
    if (options.persist !== false) this.#onClose?.(tab.projection);
    this.host.removeChildView(tab.view);
    tab.automation?.dispose();
    tab.view.webContents.destroy?.();
    this.#tabs.delete(browserTabId);
  }

  closeAll(options: { persist?: boolean } = {}): void {
    for (const browserTabId of [...this.#tabs.keys()]) this.close(browserTabId, options);
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
        })
          .then((created) => this.#select(created.browserTabId))
          .catch(() => undefined);
      }
      return { action: "deny" };
    });
    contents.on("will-navigate", (event, url) => {
      if (isRecordWithPreventDefault(event) && typeof url === "string" && !isAllowedBrowserNavigation(url))
        event.preventDefault();
    });
    contents.on("did-start-loading", () => {
      if (this.#tabs.get(browserTabId) === tab)
        this.#replace(browserTabId, { status: "loading", loadError: undefined });
    });
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
    contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
      if (isMainFrame !== true || code === ABORTED_ERROR_CODE) return;
      this.#replace(browserTabId, {
        status: "crashed",
        loadError: describeLoadFailure(description, url),
        ...(typeof url === "string" && isAllowedBrowserNavigation(url) ? { url } : {}),
      });
    });
    contents.on("render-process-gone", () => {
      if (tab.view.webContents !== contents) return;
      void this.#recoverCrashedTab(browserTabId, tab);
    });
  }

  async #recoverCrashedTab(browserTabId: string, tab: ManagedTab): Promise<void> {
    if (this.#tabs.get(browserTabId) !== tab || tab.recoveryAttempted) {
      if (this.#tabs.get(browserTabId) === tab) this.#replace(browserTabId, { status: "crashed" });
      return;
    }
    tab.recoveryAttempted = true;
    this.#replace(browserTabId, { status: "crashed" });
    const previousView = tab.view;
    try {
      const { worktreeId, profileId, url } = tab.projection;
      assertBrowserUrl(url);
      const partition = this.#sessionManager.partitionFor(worktreeId, profileId);
      const browserSession = this.#sessionModule
        ? this.#sessionManager.getSession(this.#sessionModule, worktreeId, profileId)
        : undefined;
      const replacement = this.factory.create({ partition, ...(browserSession ? { session: browserSession } : {}) });
      replacement.setBounds(
        tab.projection.viewport ? fitViewport(tab.bounds, tab.projection.viewport).bounds : tab.bounds,
      );
      replacement.setVisible(tab.projection.active && !this.#hidden);
      this.host.removeChildView(previousView);
      this.host.addChildView(replacement);
      tab.automation?.dispose();
      const automation = this.#automationFactory?.(replacement);
      tab.view = replacement;
      tab.automation = automation?.automation;
      tab.designMode = automation?.designMode;
      tab.emulatedScale = undefined;
      previousView.webContents.destroy?.();
      this.#installObservers(browserTabId, tab);
      this.#replace(browserTabId, { status: "loading", loadError: undefined });
      await this.#load(browserTabId, tab, url);
      await this.#startAutomation(tab);
      await this.#layout(tab).catch(() => undefined);
    } catch {
      if (this.#tabs.get(browserTabId) === tab) this.#replace(browserTabId, { status: "crashed" });
    }
  }

  async #startAutomation(tab: ManagedTab): Promise<void> {
    const automation = tab.automation;
    if (!automation) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      automation.start().catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, AUTOMATION_START_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
  }

  async #load(browserTabId: string, tab: ManagedTab, url: string): Promise<void> {
    try {
      await tab.view.webContents.loadURL(url);
    } catch (cause) {
      if (this.#tabs.get(browserTabId) !== tab || isAbortedLoad(cause)) return;
      this.#replace(browserTabId, {
        status: "crashed",
        loadError: describeLoadFailure(cause instanceof Error ? cause.message : undefined, url),
      });
    }
  }

  async #layout(tab: ManagedTab): Promise<void> {
    const viewport = tab.projection.viewport;
    if (!viewport) {
      tab.view.setBounds(tab.bounds);
      return;
    }
    const fitted = fitViewport(tab.bounds, viewport);
    tab.view.setBounds(fitted.bounds);
    if (!tab.automation || tab.emulatedScale === fitted.scale) return;
    tab.emulatedScale = fitted.scale;
    await tab.automation.emulate(emulationFor(viewport, fitted.scale));
  }

  #replace(browserTabId: string, patch: ProjectionPatch): void {
    const current = this.#require(browserTabId);
    const merged: Record<string, unknown> = { ...current.projection, ...patch };
    for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
    current.projection = BrowserTabProjection.parse(merged);
    this.#publish(current.projection);
  }

  #publish(tab: BrowserTabProjectionValue): void {
    try {
      this.#onProjection?.(tab);
    } catch {
      // Persistence failure must not tear down the live browser view.
    }
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

/**
 * Places a device viewport inside the pane surface at the largest scale up to 1 that fits, centred.
 * The view keeps the device's aspect ratio instead of stretching to the pane.
 */
export function fitViewport(
  surface: BrowserBoundsValue,
  viewport: Pick<BrowserViewportValue, "width" | "height">,
): { bounds: BrowserBoundsValue; scale: number } {
  const scale = Math.min(1, surface.width / viewport.width, surface.height / viewport.height);
  const width = Math.max(1, Math.floor(viewport.width * scale));
  const height = Math.max(1, Math.floor(viewport.height * scale));
  return {
    bounds: {
      x: surface.x + Math.floor((surface.width - width) / 2),
      y: surface.y + Math.floor((surface.height - height) / 2),
      width,
      height,
    },
    scale,
  };
}

const IPHONE_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IPAD_USER_AGENT =
  "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const ANDROID_USER_AGENT =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36";

export function emulationFor(viewport: BrowserViewportValue, scale: number): BrowserEmulation {
  const preset = viewport.preset ?? "";
  const userAgent = !viewport.mobile
    ? undefined
    : preset.startsWith("iphone")
      ? IPHONE_USER_AGENT
      : preset.startsWith("ipad")
        ? IPAD_USER_AGENT
        : ANDROID_USER_AGENT;
  return {
    width: viewport.width,
    height: viewport.height,
    mobile: viewport.mobile,
    scale,
    ...(viewport.deviceScaleFactor === undefined ? {} : { deviceScaleFactor: viewport.deviceScaleFactor }),
    ...(userAgent ? { userAgent } : {}),
  };
}

const ABORTED_ERROR_CODE = -3;

// Electron rejects loadURL with ERR_ABORTED when a navigation is superseded (redirects, a newer
// loadURL); that is not a failure the user needs to see.
function isAbortedLoad(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null) return false;
  const { code, errno } = cause as { code?: unknown; errno?: unknown };
  return code === "ERR_ABORTED" || errno === ABORTED_ERROR_CODE;
}

function describeLoadFailure(detail: unknown, url: unknown): string {
  const target = typeof url === "string" && isAllowedBrowserNavigation(url) ? url : "the page";
  const reason = typeof detail === "string" && detail.trim() ? detail.trim() : "the page did not respond";
  return `Could not load ${target}: ${reason}`.slice(0, 512);
}

function assertBrowserUrl(url: string): void {
  if (!isAllowedBrowserNavigation(url))
    throw new Error("Invalid browser URL: only http(s) or about:blank navigation is allowed.");
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
  try {
    return contents.getTitle().slice(0, 512);
  } catch {
    return fallback;
  }
}

function isRecordWithPreventDefault(value: unknown): value is { preventDefault(): void } {
  return (
    typeof value === "object" &&
    value !== null &&
    "preventDefault" in value &&
    typeof value.preventDefault === "function"
  );
}
