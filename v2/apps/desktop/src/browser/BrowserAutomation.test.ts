import { describe, expect, it } from "vitest";

import { BrowserAutomation, type CdpClientLike } from "./BrowserAutomation.js";

function fakeCdp(): { cdp: CdpClientLike; commands: Array<{ method: string; params?: unknown }>; emit: (method: string, params: unknown) => void } {
  const commands: Array<{ method: string; params?: unknown }> = [];
  const listeners = new Set<(method: string, params: unknown) => void>();
  const cdp: CdpClientLike = {
    send: async (method, params) => {
      commands.push({ method, ...(params === undefined ? {} : { params }) });
      if (method === "Runtime.evaluate" && typeof params === "object" && params !== null && "expression" in params) {
        const expression = String((params as { expression: unknown }).expression);
        if (expression.includes("tagName")) return { result: { result: { value: { tag: "button", name: "Save", url: "https://example.com" } } } };
        if (expression.includes("getBoundingClientRect")) return { result: { result: { value: { x: 20, y: 30, width: 100, height: 40 } } } };
        return { result: { result: { value: { tag: "button", name: "Save", url: "https://example.com" } } } };
      }
      if (method === "Page.captureScreenshot") return { data: "aGVsbG8=" };
      return {};
    },
    onMessage: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  return { cdp, commands, emit: (method, params) => { for (const listener of listeners) listener(method, params); } };
}

describe("BrowserAutomation", () => {
  it("enables the CDP domains required for automation, design mode, and diagnostics", async () => {
    const { cdp, commands } = fakeCdp();
    await new BrowserAutomation(cdp).start();
    expect(commands.map((command) => command.method)).toEqual(expect.arrayContaining([
      "Page.enable", "Runtime.enable", "DOM.enable", "DOMSnapshot.enable", "Accessibility.enable", "Network.enable", "Log.enable",
    ]));
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
    emit("Network.requestWillBeSent", { requestId: "2", request: { url: "wss://example.com/socket", type: "WebSocket" } });
    await expect(waiting).resolves.toEqual({ idle: true });
  });
});
