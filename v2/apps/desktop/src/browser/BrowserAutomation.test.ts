import { describe, expect, it } from "vitest";

import { BrowserAutomation, type CdpClientLike } from "./BrowserAutomation.js";

function fakeCdp(): {
  cdp: CdpClientLike;
  commands: Array<{ method: string; params?: unknown }>;
  emit: (method: string, params: unknown) => void;
} {
  const commands: Array<{ method: string; params?: unknown }> = [];
  const listeners = new Set<(method: string, params: unknown) => void>();
  const cdp: CdpClientLike = {
    send: async (method, params) => {
      commands.push({ method, ...(params === undefined ? {} : { params }) });
      if (method === "Runtime.evaluate" && typeof params === "object" && params !== null && "expression" in params) {
        const expression = String((params as { expression: unknown }).expression);
        if (expression.includes("tagName"))
          return { result: { result: { value: { tag: "button", name: "Save", url: "https://example.com" } } } };
        if (expression.includes("getBoundingClientRect"))
          return { result: { result: { value: { x: 20, y: 30, width: 100, height: 40 } } } };
        return { result: { result: { value: { tag: "button", name: "Save", url: "https://example.com" } } } };
      }
      if (method === "Page.captureScreenshot") return { data: "aGVsbG8=" };
      return {};
    },
    onMessage: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    cdp,
    commands,
    emit: (method, params) => {
      for (const listener of listeners) listener(method, params);
    },
  };
}

describe("BrowserAutomation", () => {
  it("enables the CDP domains required for automation, design mode, and diagnostics", async () => {
    const { cdp, commands } = fakeCdp();
    await new BrowserAutomation(cdp).start();
    expect(commands.map((command) => command.method)).toEqual(
      expect.arrayContaining([
        "Page.enable",
        "Runtime.enable",
        "DOM.enable",
        "DOMSnapshot.enable",
        "Accessibility.enable",
        "Network.enable",
        "Log.enable",
      ]),
    );
  });

  it("dispatches trusted input through Chromium and bounds returned data", async () => {
    const { cdp, commands } = fakeCdp();
    const automation = new BrowserAutomation(cdp);
    await automation.start();
    await automation.click({ selector: "#save" });
    await automation.fill({ selector: "#name", value: "ZLI" });
    const screenshot = await automation.screenshot();
    const inspection = await automation.inspectElement({ selector: "#save" });
    expect(commands.some((command) => command.method === "Input.dispatchMouseEvent")).toBe(true);
    expect(commands.some((command) => command.method === "Input.insertText")).toBe(true);
    expect(screenshot).toEqual({ data: "aGVsbG8=", mimeType: "image/png" });
    expect(inspection).toMatchObject({ tag: "button", name: "Save" });
  });

  it("waits for tracked requests to settle while ignoring sockets and event streams", async () => {
    const { cdp, emit } = fakeCdp();
    const automation = new BrowserAutomation(cdp);
    await automation.start();
    const waiting = automation.waitForNetworkIdle({ idleMs: 10, timeoutMs: 200 });
    emit("Network.requestWillBeSent", { requestId: "1", request: { url: "https://example.com/api", type: "Fetch" } });
    emit("Network.loadingFinished", { requestId: "1" });
    emit("Network.requestWillBeSent", {
      requestId: "2",
      request: { url: "wss://example.com/socket", type: "WebSocket" },
    });
    await expect(waiting).resolves.toEqual({ idle: true });
  });

  it("keeps oversized CDP diagnostics bounded without crashing the message handler", async () => {
    const { cdp, emit } = fakeCdp();
    const automation = new BrowserAutomation(cdp);
    await automation.start();

    expect(() =>
      emit("Network.requestWillBeSent", {
        requestId: "large-request",
        request: { url: `https://example.com/${"x".repeat(8 * 1024 * 1024 + 32)}`, type: "Fetch" },
      }),
    ).not.toThrow();
    expect(JSON.stringify(automation.networkEntries()).length).toBeLessThan(16_384);
  });

  it("redacts sensitive network headers and keeps non-secret diagnostic fields", async () => {
    const { cdp, emit } = fakeCdp();
    const automation = new BrowserAutomation(cdp);
    await automation.start();

    const secrets = {
      cookie: "session=super-secret-cookie",
      authorization: "Bearer super-secret-token",
      proxyAuthorization: "Basic cHJveHk6c2VjcmV0",
      apiKey: "sk-live-do-not-persist",
      apiKeyAlias: "api-key-secret-value",
      authToken: "x-auth-token-secret",
      accessToken: "x-access-token-secret",
      csrf: "csrf-secret-value",
      xsrf: "xsrf-secret-value",
      setCookie: "sid=another-secret-cookie",
      redirectCookie: "redirect-secret-cookie",
      redirectAuthorization: "Bearer redirect-secret-token",
      oversizedCookie: `session=oversized-secret-cookie-${"z".repeat(20_000)}`,
    };

    emit("Network.requestWillBeSent", {
      requestId: "req-auth",
      loaderId: "loader-1",
      documentURL: "https://example.com/dashboard",
      timestamp: 1.25,
      wallTime: 1_700_000_000,
      initiator: { type: "script" },
      request: {
        url: "https://api.example.com/v1/items?q=widget",
        method: "GET",
        type: "Fetch",
        headers: {
          Cookie: secrets.cookie,
          Authorization: secrets.authorization,
          "Proxy-Authorization": secrets.proxyAuthorization,
          "X-Api-Key": secrets.apiKey,
          "Api-Key": secrets.apiKeyAlias,
          "X-Auth-Token": secrets.authToken,
          "X-Access-Token": secrets.accessToken,
          "X-CSRF-Token": secrets.csrf,
          "X-XSRF-Token": secrets.xsrf,
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "ZLI-Diagnostic",
          "X-Request-Id": "req-visible-42",
          "WWW-Authenticate": "Bearer realm=example",
        },
        initialPriority: "High",
        referrerPolicy: "strict-origin-when-cross-origin",
      },
      redirectResponse: {
        url: "https://example.com/login",
        status: 302,
        statusText: "Found",
        mimeType: "text/html",
        headers: [
          { name: "Set-Cookie", value: secrets.setCookie },
          { name: "Location", value: "/dashboard" },
          { name: "Cache-Control", value: "no-store" },
        ],
        requestHeaders: {
          cookie: secrets.redirectCookie,
          Authorization: secrets.redirectAuthorization,
          accept: "text/html",
        },
      },
    });
    emit("Network.requestWillBeSent", {
      requestId: "req-oversized-cookie",
      documentURL: "https://example.com/page",
      request: {
        url: "https://example.com/api/items?q=widget",
        method: "POST",
        headers: {
          Cookie: secrets.oversizedCookie,
          "Content-Type": "application/json",
        },
      },
    });

    const persisted = JSON.stringify(automation.networkEntries());
    for (const secret of Object.values(secrets)) expect(persisted).not.toContain(secret);
    expect(persisted).not.toContain("oversized-secret-cookie");

    expect(automation.networkEntries()).toEqual([
      {
        requestId: "req-auth",
        loaderId: "loader-1",
        documentURL: "https://example.com/dashboard",
        timestamp: 1.25,
        wallTime: 1_700_000_000,
        initiator: { type: "script" },
        request: {
          url: "https://api.example.com/v1/items?q=widget",
          method: "GET",
          type: "Fetch",
          headers: {
            Cookie: "[REDACTED]",
            Authorization: "[REDACTED]",
            "Proxy-Authorization": "[REDACTED]",
            "X-Api-Key": "[REDACTED]",
            "Api-Key": "[REDACTED]",
            "X-Auth-Token": "[REDACTED]",
            "X-Access-Token": "[REDACTED]",
            "X-CSRF-Token": "[REDACTED]",
            "X-XSRF-Token": "[REDACTED]",
            "Content-Type": "application/json",
            Accept: "application/json",
            "User-Agent": "ZLI-Diagnostic",
            "X-Request-Id": "req-visible-42",
            "WWW-Authenticate": "Bearer realm=example",
          },
          initialPriority: "High",
          referrerPolicy: "strict-origin-when-cross-origin",
        },
        redirectResponse: {
          url: "https://example.com/login",
          status: 302,
          statusText: "Found",
          mimeType: "text/html",
          headers: [
            { name: "Set-Cookie", value: "[REDACTED]" },
            { name: "Location", value: "/dashboard" },
            { name: "Cache-Control", value: "no-store" },
          ],
          requestHeaders: {
            cookie: "[REDACTED]",
            Authorization: "[REDACTED]",
            accept: "text/html",
          },
        },
      },
      {
        requestId: "req-oversized-cookie",
        documentURL: "https://example.com/page",
        request: {
          url: "https://example.com/api/items?q=widget",
          method: "POST",
          headers: {
            Cookie: "[REDACTED]",
            "Content-Type": "application/json",
          },
        },
      },
    ]);
  });
});

describe("BrowserAutomation device emulation", () => {
  it("emulates the device and scales trusted input into the fitted view", async () => {
    const { cdp, commands } = fakeCdp();
    const prepared: string[] = [];
    const automation = new BrowserAutomation(cdp, {
      prepareInput: async () => {
        prepared.push("wake");
      },
    });
    await automation.emulate({
      width: 393,
      height: 852,
      mobile: true,
      deviceScaleFactor: 3,
      scale: 0.5,
      userAgent: "iPhone",
    });
    expect(commands.find((command) => command.method === "Emulation.setDeviceMetricsOverride")?.params).toMatchObject({
      width: 393,
      height: 852,
      deviceScaleFactor: 3,
      mobile: true,
      scale: 0.5,
    });
    expect(commands.find((command) => command.method === "Emulation.setUserAgentOverride")?.params).toEqual({
      userAgent: "iPhone",
    });

    await automation.click({ x: 100, y: 200 });
    const mouse = commands.filter((command) => command.method === "Input.dispatchMouseEvent");
    expect(mouse.map((command) => (command.params as { type: string }).type)).toEqual([
      "mouseMoved",
      "mousePressed",
      "mouseReleased",
    ]);
    expect(mouse[1]?.params).toMatchObject({ x: 50, y: 100 });
    expect(prepared).toEqual(["wake"]);

    await automation.emulate(null);
    expect(commands.some((command) => command.method === "Emulation.clearDeviceMetricsOverride")).toBe(true);
    await automation.click({ x: 100, y: 200 });
    expect(commands.filter((command) => command.method === "Input.dispatchMouseEvent").at(-1)?.params).toMatchObject({
      x: 100,
      y: 200,
    });
  });
});
