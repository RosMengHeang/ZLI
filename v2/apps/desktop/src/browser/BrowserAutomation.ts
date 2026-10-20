const MAX_RESULT_BYTES = 8 * 1024 * 1024;
const MAX_DIAGNOSTIC_ENTRIES = 500;
const MAX_DIAGNOSTIC_ENTRY_BYTES = 16 * 1024;
const MAX_SNAPSHOT_ELEMENTS = 200;
const MAX_SNAPSHOT_TEXT = 20_000;
const MAX_EVALUATE_RESULT_CHARS = 100_000;
const INPUT_TIMEOUT_MS = 5_000;
const CAPTURE_TIMEOUT_MS = 5_000;
const MAX_FULL_PAGE_HEIGHT = 16_384;

const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input:not([type=hidden])",
  "textarea",
  "select",
  "summary",
  "[contenteditable='']",
  "[contenteditable='true']",
  "[role=button]",
  "[role=link]",
  "[role=checkbox]",
  "[role=radio]",
  "[role=switch]",
  "[role=tab]",
  "[role=menuitem]",
  "[role=option]",
  "[role=combobox]",
  "[role=textbox]",
].join(",");

export type CdpClientLike = {
  send(method: string, params?: unknown): Promise<unknown>;
  onMessage(listener: (method: string, params: unknown) => void): () => void;
};

export type BrowserSnapshotElement = {
  readonly tag: string;
  readonly name: string;
  readonly role: string | null;
  readonly selector?: string;
  readonly type?: string;
  readonly href?: string;
  readonly value?: string;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly checked?: boolean;
  readonly inViewport?: boolean;
};

export type BrowserSnapshot = {
  readonly url: string;
  readonly title: string;
  readonly interactiveElements: readonly unknown[];
  /** Visible page text, cut at 20,000 characters. */
  readonly text?: string;
  readonly textTruncated?: boolean;
  readonly viewport?: { width: number; height: number; scrollX: number; scrollY: number; scrollHeight: number };
};

export type BrowserScreenshot = {
  readonly data: string;
  readonly mimeType: "image/png" | "image/jpeg";
};

export type BrowserScreenshotOptions = {
  readonly format?: "png" | "jpeg";
  readonly clip?: { x: number; y: number; width: number; height: number; scale?: number };
  readonly fullPage?: boolean;
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

export type BrowserClickInput = { selector: string } | { text: string } | { x: number; y: number };

export type BrowserClickResult = {
  readonly x: number;
  readonly y: number;
  readonly element?: string;
};

export type BrowserEvaluateResult = {
  readonly type: string;
  readonly value?: unknown;
  readonly description?: string;
  readonly truncated?: boolean;
};

export type BrowserConsoleMessage = {
  readonly level: string;
  readonly text: string;
  readonly url?: string;
  readonly line?: number;
};

export type BrowserNetworkRequest = {
  readonly method: string;
  readonly url: string;
  readonly type?: string;
  readonly status?: number;
  readonly statusText?: string;
  readonly mimeType?: string;
  readonly failed?: string;
};

/** Device metrics in CSS pixels. `scale` shrinks the rendered image so the device fits its pane. */
export type BrowserEmulation = {
  readonly width: number;
  readonly height: number;
  readonly deviceScaleFactor?: number;
  readonly mobile: boolean;
  readonly scale: number;
  readonly userAgent?: string;
};

export type BrowserAutomationOptions = {
  /** Runs before trusted input; hidden Chromium widgets drop mouse events until they are woken. */
  readonly prepareInput?: () => Promise<void>;
  /** Used when CDP capture stalls, which happens while the window is minimized or occluded. */
  readonly captureFallback?: (format: "png" | "jpeg") => Promise<string | undefined>;
};

type NetworkRecord = {
  method: string;
  url: string;
  type?: string;
  status?: number;
  statusText?: string;
  mimeType?: string;
  failed?: string;
};

export class BrowserAutomation {
  readonly #pendingRequests = new Set<string>();
  readonly #consoleEntries: unknown[] = [];
  readonly #networkEntries: unknown[] = [];
  readonly #networkLog = new Map<string, NetworkRecord>();
  readonly #options: BrowserAutomationOptions;
  #removeMessageListener: (() => void) | undefined;
  #started = false;
  #inputScale = 1;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  #waitTimeout: ReturnType<typeof setTimeout> | undefined;
  #idleResolve: ((result: { idle: boolean }) => void) | undefined;

  constructor(
    private readonly cdp: CdpClientLike,
    options: BrowserAutomationOptions = {},
  ) {
    this.#options = options;
  }

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
    const value = await this.#evaluate(`(() => {
      const interactive = ${JSON.stringify(INTERACTIVE_SELECTOR)};
      const unique = (selector) => { try { return document.querySelectorAll(selector).length === 1; } catch { return false; } };
      const quote = (value) => '"' + value.replace(/["\\\\]/g, '\\\\$&') + '"';
      const selectorFor = (element) => {
        if (element.id && unique('#' + CSS.escape(element.id))) return '#' + CSS.escape(element.id);
        const tag = element.localName;
        for (const attribute of ['data-testid', 'data-test', 'data-cy', 'name', 'aria-label', 'placeholder']) {
          const value = element.getAttribute(attribute);
          if (value && value.length <= 120) {
            const selector = tag + '[' + attribute + '=' + quote(value) + ']';
            if (unique(selector)) return selector;
          }
        }
        const parts = [];
        let node = element;
        while (node && node.nodeType === 1 && node !== document.documentElement) {
          if (node !== element && node.id && unique('#' + CSS.escape(node.id))) { parts.unshift('#' + CSS.escape(node.id)); break; }
          let part = node.localName;
          const parent = node.parentElement;
          if (parent) {
            const siblings = Array.from(parent.children).filter((child) => child.localName === node.localName);
            if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
          }
          parts.unshift(part);
          node = parent;
        }
        return parts.join(' > ');
      };
      const clean = (value) => (value || '').replace(/\\s+/g, ' ').trim();
      const elements = [];
      for (const element of document.querySelectorAll(interactive)) {
        if (elements.length >= ${MAX_SNAPSHOT_ELEMENTS}) break;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0 || getComputedStyle(element).visibility === 'hidden') continue;
        const type = element.getAttribute('type');
        const entry = {
          tag: element.localName,
          name: clean(element.getAttribute('aria-label') || element.innerText || element.getAttribute('title') || element.getAttribute('alt') || element.getAttribute('placeholder') || element.getAttribute('name')).slice(0, 200),
          role: element.getAttribute('role'),
          selector: selectorFor(element),
          inViewport: rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth,
        };
        if (type) entry.type = type;
        if (element.localName === 'a' && element.href) entry.href = element.href.slice(0, 500);
        if ('value' in element && typeof element.value === 'string' && element.value && type !== 'password') entry.value = element.value.slice(0, 200);
        if (element.getAttribute('placeholder')) entry.placeholder = element.getAttribute('placeholder').slice(0, 200);
        if (element.disabled === true || element.getAttribute('aria-disabled') === 'true') entry.disabled = true;
        if (element.checked === true || element.getAttribute('aria-checked') === 'true') entry.checked = true;
        elements.push(entry);
      }
      const text = document.body ? document.body.innerText : '';
      return {
        url: location.href,
        title: document.title.slice(0, 512),
        interactiveElements: elements,
        text: text.slice(0, ${MAX_SNAPSHOT_TEXT}),
        textTruncated: text.length > ${MAX_SNAPSHOT_TEXT},
        viewport: { width: innerWidth, height: innerHeight, scrollX: Math.round(scrollX), scrollY: Math.round(scrollY), scrollHeight: document.documentElement.scrollHeight },
      };
    })()`);
    if (!isRecord(value)) throw new Error("Browser snapshot returned an invalid payload.");
    return {
      url: typeof value.url === "string" ? value.url : "",
      title: typeof value.title === "string" ? value.title : "",
      interactiveElements: Array.isArray(value.interactiveElements)
        ? value.interactiveElements.slice(0, MAX_SNAPSHOT_ELEMENTS)
        : [],
      ...(typeof value.text === "string" ? { text: value.text.slice(0, MAX_SNAPSHOT_TEXT) } : {}),
      ...(value.textTruncated === true ? { textTruncated: true } : {}),
      ...(isRecord(value.viewport) ? { viewport: value.viewport as NonNullable<BrowserSnapshot["viewport"]> } : {}),
    };
  }

  async click(input: BrowserClickInput): Promise<BrowserClickResult> {
    await this.start();
    const target = "x" in input ? { x: input.x, y: input.y } : await this.#locate(input);
    await this.#prepareInput();
    const x = target.x * this.#inputScale;
    const y = target.y * this.#inputScale;
    // Mouse moves are frame-aligned, so their ack can lag by most of a second in a view that is
    // not on screen. The press that follows flushes the queued move first, so order is kept
    // without waiting for that ack.
    const moved = this.#input("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
    moved.catch(() => undefined);
    await this.#input("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await this.#input("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    await moved.catch(() => undefined);
    return target;
  }

  async fill(input: { selector: string; value: string }): Promise<void> {
    await this.start();
    const value = input.value.slice(0, 100_000);
    const prepared = await this.#evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(input.selector)});
      if (!element) return { error: 'No element matches the selector ' + ${JSON.stringify(JSON.stringify(input.selector))} + '.' };
      const value = ${JSON.stringify(value)};
      element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      if (element.disabled || element.readOnly) return { error: 'The element is disabled or read-only.' };
      if (element.localName === 'select') {
        const option = Array.from(element.options).find((candidate) => candidate.value === value || candidate.label === value || candidate.text.trim() === value);
        if (!option) return { error: 'The select element has no option ' + JSON.stringify(value) + '.' };
        element.value = option.value;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return { kind: 'done' };
      }
      const nonText = ['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'image', 'hidden'];
      const valueOnly = ['date', 'time', 'datetime-local', 'month', 'week', 'color', 'range'];
      const isInput = element.localName === 'input';
      if (isInput && nonText.includes(element.type)) return { error: 'A ' + element.type + ' input cannot be filled; click it instead.' };
      if (!isInput && element.localName !== 'textarea' && !element.isContentEditable) return { error: 'The element is not a text field, select, or editable region.' };
      element.focus();
      if (isInput && valueOnly.includes(element.type)) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return { kind: 'done' };
      }
      if (element.isContentEditable) {
        const range = document.createRange();
        range.selectNodeContents(element);
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      } else if (isInput && ['email', 'number'].includes(element.type)) {
        // These types expose no selection API, so select() cannot be relied on to replace the old value.
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, '');
        element.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        element.select();
      }
      return { kind: 'text' };
    })()`);
    if (isRecord(prepared) && typeof prepared.error === "string") throw new Error(prepared.error);
    if (isRecord(prepared) && prepared.kind === "done") return;
    await this.#prepareInput();
    if (value === "") await this.#evaluate("document.execCommand('delete')");
    else await this.#input("Input.insertText", { text: value });
  }

  async press(input: { key: string }): Promise<void> {
    await this.start();
    const key = parseKey(input.key);
    await this.#prepareInput();
    await this.#input("Input.dispatchKeyEvent", {
      type: key.text ? "keyDown" : "rawKeyDown",
      modifiers: key.modifiers,
      key: key.key,
      code: key.code,
      windowsVirtualKeyCode: key.keyCode,
      ...(key.text ? { text: key.text, unmodifiedText: key.text } : {}),
    });
    await this.#input("Input.dispatchKeyEvent", {
      type: "keyUp",
      modifiers: key.modifiers,
      key: key.key,
      code: key.code,
      windowsVirtualKeyCode: key.keyCode,
    });
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

  async waitForSelector(selector: string, options: { timeoutMs?: number } = {}): Promise<{ found: boolean }> {
    await this.start();
    const deadline = Date.now() + Math.max(0, Math.min(options.timeoutMs ?? 10_000, 120_000));
    const expression = `(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) return false; const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; })()`;
    for (;;) {
      if ((await this.#evaluate(expression)) === true) return { found: true };
      if (Date.now() >= deadline) return { found: false };
      await delay(100);
    }
  }

  async evaluate(expression: string, options: { timeoutMs?: number } = {}): Promise<BrowserEvaluateResult> {
    await this.start();
    const timeoutMs = Math.max(100, Math.min(options.timeoutMs ?? 10_000, 60_000));
    const response = await withTimeout(
      this.cdp.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
        replMode: true,
        timeout: timeoutMs,
      }),
      timeoutMs + 1_000,
      "The expression did not finish in time.",
    );
    throwOnException(response);
    const remote = isRecord(response) && isRecord(response.result) ? response.result : {};
    const type = typeof remote.type === "string" ? remote.type : "undefined";
    const description = typeof remote.description === "string" ? remote.description.slice(0, 2_000) : undefined;
    if (!("value" in remote)) {
      const unserializable = typeof remote.unserializableValue === "string" ? remote.unserializableValue : undefined;
      return { type, ...(unserializable ? { value: unserializable } : description ? { description } : {}) };
    }
    const serialized = JSON.stringify(remote.value) ?? "undefined";
    if (serialized.length > MAX_EVALUATE_RESULT_CHARS)
      return { type, value: serialized.slice(0, MAX_EVALUATE_RESULT_CHARS), truncated: true };
    return { type, value: remote.value };
  }

  async screenshot(options: BrowserScreenshotOptions = {}): Promise<BrowserScreenshot> {
    await this.start();
    const format = options.format ?? "png";
    let clip = options.clip;
    let captureBeyondViewport = false;
    if (options.fullPage) {
      const metrics = await this.cdp.send("Page.getLayoutMetrics");
      const size = isRecord(metrics) ? (metrics.cssContentSize ?? metrics.contentSize) : undefined;
      if (isRecord(size) && typeof size.width === "number" && typeof size.height === "number") {
        clip = {
          x: 0,
          y: 0,
          width: Math.max(1, Math.ceil(size.width)),
          height: Math.max(1, Math.min(Math.ceil(size.height), MAX_FULL_PAGE_HEIGHT)),
          scale: 1,
        };
        captureBeyondViewport = true;
      }
    }
    let data: string | undefined;
    try {
      const response = await withTimeout(
        this.cdp.send("Page.captureScreenshot", {
          format,
          ...(clip ? { clip } : {}),
          ...(captureBeyondViewport ? { captureBeyondViewport: true } : {}),
        }),
        CAPTURE_TIMEOUT_MS,
        "Browser screenshot timed out.",
      );
      data = extractData(response);
    } catch (cause) {
      if (!this.#options.captureFallback || clip) throw cause;
      data = await this.#options.captureFallback(format);
    }
    if (data === undefined || data.length > MAX_RESULT_BYTES)
      throw new Error("Browser screenshot exceeded the IPC limit.");
    return { data, mimeType: format === "jpeg" ? "image/jpeg" : "image/png" };
  }

  async emulate(emulation: BrowserEmulation | null): Promise<void> {
    await this.start();
    if (!emulation) {
      this.#inputScale = 1;
      await this.cdp.send("Emulation.clearDeviceMetricsOverride");
      await this.cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
      await this.cdp.send("Emulation.setUserAgentOverride", { userAgent: "" });
      return;
    }
    const portrait = emulation.height >= emulation.width;
    await this.cdp.send("Emulation.setDeviceMetricsOverride", {
      width: emulation.width,
      height: emulation.height,
      deviceScaleFactor: emulation.deviceScaleFactor ?? 0,
      mobile: emulation.mobile,
      scale: emulation.scale,
      screenWidth: emulation.width,
      screenHeight: emulation.height,
      screenOrientation: portrait ? { type: "portraitPrimary", angle: 0 } : { type: "landscapePrimary", angle: 90 },
    });
    await this.cdp.send(
      "Emulation.setTouchEmulationEnabled",
      emulation.mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false },
    );
    await this.cdp.send("Emulation.setUserAgentOverride", { userAgent: emulation.userAgent ?? "" });
    this.#inputScale = emulation.scale;
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

  consoleMessages(): readonly BrowserConsoleMessage[] {
    // Electron's own developer warnings are not the page's output.
    return this.#consoleEntries
      .map(summarizeConsoleEntry)
      .filter((message) => !message.url?.startsWith("node:electron"));
  }

  clearConsole(): void {
    this.#consoleEntries.length = 0;
  }

  networkEntries(): readonly unknown[] {
    return [...this.#networkEntries];
  }

  networkRequests(): readonly BrowserNetworkRequest[] {
    return [...this.#networkLog.values()].map((record) => ({ ...record }));
  }

  dispose(): void {
    this.#removeMessageListener?.();
    this.#removeMessageListener = undefined;
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    if (this.#waitTimeout) clearTimeout(this.#waitTimeout);
    this.#finishIdle({ idle: false });
  }

  async #prepareInput(): Promise<void> {
    await this.#options.prepareInput?.();
  }

  async #input(method: string, params: Record<string, unknown>): Promise<void> {
    await withTimeout(
      this.cdp.send(method, params),
      INPUT_TIMEOUT_MS,
      "The page did not accept input in time; it may be frozen or still loading.",
    );
  }

  async #evaluate(expression: string): Promise<unknown> {
    const response = await this.cdp.send("Runtime.evaluate", { expression, returnByValue: true });
    throwOnException(response);
    return extractValue(response);
  }

  async #locate(input: { selector: string } | { text: string }): Promise<BrowserClickResult> {
    const selector = "selector" in input ? input.selector : null;
    const text = "text" in input ? input.text : null;
    const value = await this.#evaluate(`(() => {
      const selector = ${JSON.stringify(selector)};
      const text = ${JSON.stringify(text)};
      const shown = (element) => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden'; };
      let element = null;
      if (selector !== null) {
        element = document.querySelector(selector);
        if (!element) return { error: 'No element matches the selector ' + JSON.stringify(selector) + '.' };
      } else {
        const wanted = text.replace(/\\s+/g, ' ').trim().toLowerCase();
        const interactive = ${JSON.stringify(INTERACTIVE_SELECTOR)};
        const label = (candidate) => (candidate.getAttribute('aria-label') || candidate.innerText || candidate.value || candidate.getAttribute('title') || candidate.getAttribute('alt') || '').replace(/\\s+/g, ' ').trim().toLowerCase();
        let best = null;
        for (const candidate of document.querySelectorAll(interactive + ',label,[role],h1,h2,h3,h4,li,td,th,p,span,div')) {
          const candidateLabel = label(candidate);
          if (!candidateLabel || (candidateLabel !== wanted && !candidateLabel.includes(wanted)) || !shown(candidate)) continue;
          const score = (candidateLabel === wanted ? 0 : 2) + (candidate.matches(interactive) ? 0 : 1);
          if (!best || score < best.score || (score === best.score && candidateLabel.length < best.length)) best = { candidate, score, length: candidateLabel.length };
        }
        element = best ? best.candidate : null;
        if (!element) return { error: 'No visible element contains the text ' + JSON.stringify(text) + '.' };
      }
      let rect = element.getBoundingClientRect();
      if (rect.top < 0 || rect.left < 0 || rect.bottom > innerHeight || rect.right > innerWidth) {
        element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        rect = element.getBoundingClientRect();
      }
      if (rect.width <= 0 || rect.height <= 0) return { error: 'The element is not visible, so it cannot be clicked.' };
      const name = (element.getAttribute('aria-label') || element.innerText || element.value || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, element: element.localName + (name ? ' "' + name + '"' : '') };
    })()`);
    if (isRecord(value) && typeof value.error === "string") throw new Error(value.error);
    if (!isRecord(value) || typeof value.x !== "number" || typeof value.y !== "number")
      throw new Error("Element has no clickable bounds.");
    return { x: value.x, y: value.y, ...(typeof value.element === "string" ? { element: value.element } : {}) };
  }

  #onMessage(method: string, params: unknown): void {
    if (method === "Network.requestWillBeSent" && isRecord(params)) {
      const request = isRecord(params.request) ? params.request : undefined;
      const type = request && typeof request.type === "string" ? request.type : "";
      if (typeof params.requestId === "string" && type !== "WebSocket" && type !== "EventSource")
        this.#pendingRequests.add(params.requestId);
      this.#networkEntries.push(trimRecord(redactSensitiveHeaders(params)));
      this.#trim(this.#networkEntries);
      if (typeof params.requestId === "string" && request && typeof request.url === "string") {
        const resourceType = typeof params.type === "string" ? params.type : type;
        this.#networkLog.delete(params.requestId);
        this.#networkLog.set(params.requestId, {
          method: typeof request.method === "string" ? request.method : "GET",
          url: request.url.slice(0, 2_000),
          ...(resourceType ? { type: resourceType } : {}),
        });
        if (this.#networkLog.size > MAX_DIAGNOSTIC_ENTRIES) {
          const oldest = this.#networkLog.keys().next().value;
          if (oldest !== undefined) this.#networkLog.delete(oldest);
        }
      }
      if (this.#pendingRequests.size > 0 && this.#idleTimer) clearTimeout(this.#idleTimer);
      return;
    }
    if (method === "Network.responseReceived" && isRecord(params) && typeof params.requestId === "string") {
      const record = this.#networkLog.get(params.requestId);
      const response = isRecord(params.response) ? params.response : undefined;
      if (record && response) {
        if (typeof response.status === "number") record.status = response.status;
        if (typeof response.statusText === "string" && response.statusText)
          record.statusText = response.statusText.slice(0, 200);
        if (typeof response.mimeType === "string" && response.mimeType)
          record.mimeType = response.mimeType.slice(0, 200);
      }
      return;
    }
    if (
      (method === "Network.loadingFinished" || method === "Network.loadingFailed") &&
      isRecord(params) &&
      typeof params.requestId === "string"
    ) {
      if (method === "Network.loadingFailed") {
        const record = this.#networkLog.get(params.requestId);
        if (record) record.failed = typeof params.errorText === "string" ? params.errorText.slice(0, 500) : "failed";
      }
      this.#pendingRequests.delete(params.requestId);
      this.#scheduleIdle(500);
      return;
    }
    if (method === "Runtime.consoleAPICalled" || method === "Log.entryAdded" || method === "Runtime.exceptionThrown") {
      const entry = isRecord(params) ? params : { value: params };
      this.#consoleEntries.push(trimRecord(method === "Runtime.exceptionThrown" ? { exception: entry } : entry));
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

type ParsedKey = { key: string; code: string; keyCode: number; text?: string; modifiers: number };

const NAMED_KEYS: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  esc: { key: "Escape", code: "Escape", keyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
};

const MODIFIER_BITS: Record<string, number> = { alt: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 };

/** Parses "Enter", "a", or chords such as "Control+Shift+K" into a CDP key event. */
export function parseKey(input: string): ParsedKey {
  const parts =
    input.length <= 1 ? [input] : input.endsWith("+") ? [...input.slice(0, -2).split("+"), "+"] : input.split("+");
  const name = parts.pop() ?? "";
  let modifiers = 0;
  for (const part of parts) {
    const bit = MODIFIER_BITS[part.trim().toLowerCase()];
    if (bit === undefined) throw new Error(`Unknown key modifier: ${part}`);
    modifiers |= bit;
  }
  const named = NAMED_KEYS[name.toLowerCase()];
  const commandChord = (modifiers & (1 | 2 | 4)) !== 0;
  if (named) {
    const { text, ...rest } = named;
    return { ...rest, modifiers, ...(text && !commandChord ? { text } : {}) };
  }
  if (/^F([1-9]|1[0-2])$/iu.test(name)) {
    const number = Number(name.slice(1));
    return { key: name.toUpperCase(), code: name.toUpperCase(), keyCode: 111 + number, modifiers };
  }
  if ([...name].length !== 1) throw new Error(`Unknown key: ${name}`);
  const upper = name.toUpperCase();
  const code = /^[a-z]$/iu.test(name) ? `Key${upper}` : /^[0-9]$/u.test(name) ? `Digit${name}` : "";
  const keyCode = /^[a-z0-9]$/iu.test(name) ? upper.charCodeAt(0) : 0;
  const key = modifiers & 8 && /^[a-z]$/u.test(name) ? upper : name;
  return { key, code, keyCode, modifiers, ...(commandChord ? {} : { text: key }) };
}

function summarizeConsoleEntry(entry: unknown): BrowserConsoleMessage {
  if (!isRecord(entry)) return { level: "log", text: String(entry) };
  if (isRecord(entry.exception)) {
    const details = entry.exception.exceptionDetails;
    const exception = isRecord(details) && isRecord(details.exception) ? details.exception : undefined;
    const text =
      (exception && typeof exception.description === "string" ? exception.description : undefined) ??
      (isRecord(details) && typeof details.text === "string" ? details.text : "Uncaught exception");
    return {
      level: "error",
      text: text.slice(0, 4_000),
      ...(isRecord(details) && typeof details.url === "string" && details.url ? { url: details.url } : {}),
      ...(isRecord(details) && typeof details.lineNumber === "number" ? { line: details.lineNumber + 1 } : {}),
    };
  }
  if (isRecord(entry.entry)) {
    const logEntry = entry.entry;
    return {
      level: typeof logEntry.level === "string" ? logEntry.level : "info",
      text: (typeof logEntry.text === "string" ? logEntry.text : "").slice(0, 4_000),
      ...(typeof logEntry.url === "string" && logEntry.url ? { url: logEntry.url } : {}),
      ...(typeof logEntry.lineNumber === "number" ? { line: logEntry.lineNumber + 1 } : {}),
    };
  }
  if (entry.truncated === true) return { level: "log", text: "[entry too large to keep]" };
  const args = Array.isArray(entry.args) ? entry.args : [];
  const text = args
    .map((argument) => {
      if (!isRecord(argument)) return String(argument);
      if ("value" in argument)
        return typeof argument.value === "string" ? argument.value : JSON.stringify(argument.value);
      if (typeof argument.unserializableValue === "string") return argument.unserializableValue;
      return typeof argument.description === "string" ? argument.description : String(argument.type ?? "");
    })
    .join(" ");
  const level = typeof entry.type === "string" ? (entry.type === "warning" ? "warn" : entry.type) : "log";
  const frame =
    isRecord(entry.stackTrace) && Array.isArray(entry.stackTrace.callFrames)
      ? entry.stackTrace.callFrames[0]
      : undefined;
  return {
    level,
    text: text.slice(0, 4_000),
    ...(isRecord(frame) && typeof frame.url === "string" && frame.url ? { url: frame.url } : {}),
    ...(isRecord(frame) && typeof frame.lineNumber === "number" ? { line: frame.lineNumber + 1 } : {}),
  };
}

function throwOnException(response: unknown): void {
  if (!isRecord(response) || !isRecord(response.exceptionDetails)) return;
  const details = response.exceptionDetails;
  const exception = isRecord(details.exception) ? details.exception : undefined;
  const message =
    (exception && typeof exception.description === "string" ? exception.description : undefined) ??
    (typeof details.text === "string" ? details.text : "The page script threw an exception.");
  throw new Error(message.slice(0, 2_000));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

const REDACTED_HEADER_VALUE = "[REDACTED]";

const HEADER_CONTAINER_KEYS = new Set(["headers", "requestheaders", "responseheaders"]);

const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "x-auth-token",
  "x-access-token",
  "x-csrf-token",
  "x-xsrf-token",
]);

function redactSensitiveHeaders(value: Record<string, unknown>): Record<string, unknown> {
  return redactDiagnosticValue(value) as Record<string, unknown>;
}

function redactDiagnosticValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => redactDiagnosticValue(entry));
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = isHeaderContainer(key) ? redactHeaderContainer(child) : redactDiagnosticValue(child);
  }
  return result;
}

function redactHeaderContainer(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => redactHeaderEntry(entry));
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = isSensitiveHeaderName(key) ? REDACTED_HEADER_VALUE : child;
  }
  return result;
}

function redactHeaderEntry(entry: unknown): unknown {
  if (!isRecord(entry) || typeof entry.name !== "string" || !isSensitiveHeaderName(entry.name)) {
    return redactDiagnosticValue(entry);
  }
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(entry)) {
    result[key] = key === "value" ? REDACTED_HEADER_VALUE : redactDiagnosticValue(child);
  }
  return result;
}

function isHeaderContainer(key: string): boolean {
  return HEADER_CONTAINER_KEYS.has(key.toLowerCase());
}

function isSensitiveHeaderName(name: string): boolean {
  return SENSITIVE_HEADER_NAMES.has(name.trim().toLowerCase());
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
