const MAX_RESULT_BYTES = 8 * 1024 * 1024;
const MAX_DIAGNOSTIC_ENTRIES = 500;
const MAX_DIAGNOSTIC_ENTRY_BYTES = 16 * 1024;

export type CdpClientLike = {
  send(method: string, params?: unknown): Promise<unknown>;
  onMessage(listener: (method: string, params: unknown) => void): () => void;
};

export type BrowserSnapshot = {
  readonly url: string;
  readonly title: string;
  readonly interactiveElements: readonly unknown[];
};

export type BrowserScreenshot = {
  readonly data: string;
  readonly mimeType: "image/png" | "image/jpeg";
};

export type BrowserScreenshotOptions = {
  readonly format?: "png" | "jpeg";
  readonly clip?: { x: number; y: number; width: number; height: number; scale?: number };
};

export type BrowserInspection = {
  readonly tag: string;
  readonly name: string;
  readonly text?: string;
  readonly attributes?: Record<string, string>;
  readonly styles?: Record<string, string>;
  readonly ancestry?: readonly string[];
  readonly bounds?: { x: number; y: number; width: number; height: number };
  readonly url?: string;
  readonly sourceLocation?: unknown;
};

type Point = { x: number; y: number };

export class BrowserAutomation {
  readonly #pendingRequests = new Set<string>();
  readonly #consoleEntries: unknown[] = [];
  readonly #networkEntries: unknown[] = [];
  #removeMessageListener: (() => void) | undefined;
  #started = false;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  #waitTimeout: ReturnType<typeof setTimeout> | undefined;
  #idleResolve: ((result: { idle: boolean }) => void) | undefined;

  constructor(private readonly cdp: CdpClientLike) {}

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    this.#removeMessageListener = this.cdp.onMessage((method, params) => this.#onMessage(method, params));
    for (const method of [
      "Page.enable",
      "Runtime.enable",
      "DOM.enable",
      "DOMSnapshot.enable",
      "Accessibility.enable",
      "Network.enable",
      "Log.enable",
    ])
      await this.cdp.send(method);
  }

  async snapshot(): Promise<BrowserSnapshot> {
    await this.start();
    const response = await this.cdp.send("Runtime.evaluate", {
      expression: `(() => ({
        url: location.href,
        title: document.title.slice(0, 512),
        interactiveElements: Array.from(document.querySelectorAll('a,button,input,textarea,select,[role="button"]')).slice(0, 200).map((element) => ({
          tag: element.tagName.toLowerCase(),
          name: (element.getAttribute('aria-label') || element.textContent || element.getAttribute('name') || '').trim().slice(0, 200),
          role: element.getAttribute('role'),
        })),
      }))()`,
      returnByValue: true,
    });
    const value = extractValue(response);
    if (!isRecord(value)) throw new Error("Browser snapshot returned an invalid payload.");
    return {
      url: typeof value.url === "string" ? value.url : "",
      title: typeof value.title === "string" ? value.title : "",
      interactiveElements: Array.isArray(value.interactiveElements) ? value.interactiveElements.slice(0, 200) : [],
    };
  }

  async click(input: { selector: string } | { x: number; y: number }): Promise<void> {
    await this.start();
    const point = "selector" in input ? await this.#elementCenter(input.selector) : input;
    await this.cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
    await this.cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
  }

  async fill(input: { selector: string; value: string }): Promise<void> {
    await this.start();
    const selector = JSON.stringify(input.selector);
    await this.cdp.send("Runtime.evaluate", {
      expression: `(() => { const element = document.querySelector(${selector}); if (!element) throw new Error('Element not found'); element.focus(); })()`,
      returnByValue: true,
    });
    await this.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "A", code: "KeyA", modifiers: 2 });
    await this.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "A", code: "KeyA", modifiers: 2 });
    await this.cdp.send("Input.insertText", { text: input.value.slice(0, 100_000) });
  }

  async press(input: { key: string }): Promise<void> {
    await this.start();
    await this.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: input.key, text: printableKey(input.key) });
    await this.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: input.key });
  }

  async waitForNetworkIdle(options: { idleMs?: number; timeoutMs?: number } = {}): Promise<{ idle: boolean }> {
    await this.start();
    const idleMs = Math.max(0, Math.min(options.idleMs ?? 500, 10_000));
    const timeoutMs = Math.max(idleMs, Math.min(options.timeoutMs ?? 30_000, 120_000));
    if (this.#idleResolve) throw new Error("A network-idle wait is already pending.");
    return new Promise((resolve) => {
      this.#idleResolve = resolve;
      this.#waitTimeout = setTimeout(() => this.#finishIdle({ idle: false }), timeoutMs);
      this.#scheduleIdle(idleMs);
    });
  }

  async screenshot(options: BrowserScreenshotOptions = {}): Promise<BrowserScreenshot> {
    await this.start();
    const format = options.format ?? "png";
    const response = await this.cdp.send("Page.captureScreenshot", {
      format,
      ...(options.clip ? { clip: options.clip } : {}),
    });
    const data = extractData(response);
    if (data === undefined || data.length > MAX_RESULT_BYTES)
      throw new Error("Browser screenshot exceeded the IPC limit.");
    return { data, mimeType: format === "jpeg" ? "image/jpeg" : "image/png" };
  }

  async inspectElement(input: { selector: string }): Promise<BrowserInspection> {
    await this.start();
    const selector = JSON.stringify(input.selector);
    const response = await this.cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const element = document.querySelector(${selector});
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        const styles = getComputedStyle(element);
        const attributes = Object.fromEntries(Array.from(element.attributes).slice(0, 40).map((attribute) => [attribute.name, attribute.value.slice(0, 500)]));
        return {
          tag: element.tagName.toLowerCase(),
          name: (element.getAttribute('aria-label') || element.textContent || element.getAttribute('name') || '').trim().slice(0, 500),
          text: (element.textContent || '').trim().slice(0, 2_000),
          attributes,
          styles: Object.fromEntries(['display','position','color','backgroundColor','fontSize','fontFamily','borderRadius'].map((key) => [key, styles[key]])),
          ancestry: Array.from(element.parentElement ? [element.parentElement, element.parentElement.parentElement, element.parentElement.parentElement?.parentElement] : []).filter(Boolean).map((parent) => parent.tagName.toLowerCase()).slice(0, 4),
          bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          url: location.href,
        };
      })()`,
      returnByValue: true,
    });
    const value = extractValue(response);
    if (!isRecord(value) || typeof value.tag !== "string" || typeof value.name !== "string")
      throw new Error("Element was not found.");
    return value as unknown as BrowserInspection;
  }

  consoleEntries(): readonly unknown[] {
    return [...this.#consoleEntries];
  }
  networkEntries(): readonly unknown[] {
    return [...this.#networkEntries];
  }

  dispose(): void {
    this.#removeMessageListener?.();
    this.#removeMessageListener = undefined;
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    if (this.#waitTimeout) clearTimeout(this.#waitTimeout);
    this.#finishIdle({ idle: false });
  }

  async #elementCenter(selector: string): Promise<Point> {
    const response = await this.cdp.send("Runtime.evaluate", {
      expression: `(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) throw new Error('Element not found'); const rect = element.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; })()`,
      returnByValue: true,
    });
    const value = extractValue(response);
    if (!isRecord(value) || typeof value.x !== "number" || typeof value.y !== "number")
      throw new Error("Element has no clickable bounds.");
    return { x: value.x, y: value.y };
  }

  #onMessage(method: string, params: unknown): void {
    if (method === "Network.requestWillBeSent" && isRecord(params)) {
      const request = isRecord(params.request) ? params.request : undefined;
      const type = request && typeof request.type === "string" ? request.type : "";
      if (typeof params.requestId === "string" && type !== "WebSocket" && type !== "EventSource")
        this.#pendingRequests.add(params.requestId);
      this.#networkEntries.push(trimRecord(params));
      this.#trim(this.#networkEntries);
      if (this.#pendingRequests.size > 0 && this.#idleTimer) clearTimeout(this.#idleTimer);
      return;
    }
    if (
      (method === "Network.loadingFinished" || method === "Network.loadingFailed") &&
      isRecord(params) &&
      typeof params.requestId === "string"
    ) {
      this.#pendingRequests.delete(params.requestId);
      this.#scheduleIdle(500);
      return;
    }
    if (method === "Runtime.consoleAPICalled" || method === "Log.entryAdded") {
      this.#consoleEntries.push(trimRecord(isRecord(params) ? params : { value: params }));
      this.#trim(this.#consoleEntries);
    }
  }

  #scheduleIdle(idleMs: number): void {
    if (!this.#idleResolve || this.#pendingRequests.size > 0) return;
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => this.#finishIdle({ idle: true }), idleMs);
  }

  #finishIdle(result: { idle: boolean }): void {
    if (!this.#idleResolve) return;
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    if (this.#waitTimeout) clearTimeout(this.#waitTimeout);
    const resolve = this.#idleResolve;
    this.#idleResolve = undefined;
    this.#idleTimer = undefined;
    this.#waitTimeout = undefined;
    resolve(result);
  }

  #trim(entries: unknown[]): void {
    if (entries.length > MAX_DIAGNOSTIC_ENTRIES) entries.splice(0, entries.length - MAX_DIAGNOSTIC_ENTRIES);
  }
}

function extractValue(response: unknown): unknown {
  if (!isRecord(response) || !isRecord(response.result)) return undefined;
  const result = response.result;
  if (isRecord(result.result) && "value" in result.result) return result.result.value;
  return result.value;
}

function extractData(response: unknown): string | undefined {
  if (!isRecord(response) || typeof response.data !== "string") return undefined;
  return response.data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimRecord(value: Record<string, unknown>): Record<string, unknown> {
  try {
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized, "utf8") <= MAX_DIAGNOSTIC_ENTRY_BYTES) {
      return JSON.parse(serialized) as Record<string, unknown>;
    }
  } catch {
    // A malformed diagnostic must not interrupt browser control.
  }
  return { truncated: true };
}

function printableKey(key: string): string | undefined {
  return key.length === 1 ? key : undefined;
}
