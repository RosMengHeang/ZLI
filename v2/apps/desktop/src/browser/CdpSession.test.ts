import { describe, expect, it } from "vitest";

import { CdpSession, type ElectronDebuggerLike } from "./CdpSession.js";

describe("CdpSession", () => {
  it("attaches once, correlates command calls, and forwards protocol events", async () => {
    const messages = new Set<(event: unknown, method: string, params: unknown) => void>();
    const commands: string[] = [];
    const debuggerLike: ElectronDebuggerLike = {
      attach: async () => undefined,
      detach: async () => undefined,
      sendCommand: async (method) => {
        commands.push(method);
        return { ok: true };
      },
      on: (_event, listener) => {
        messages.add(listener);
      },
      removeListener: (_event, listener) => {
        messages.delete(listener);
      },
    };
    const session = new CdpSession(debuggerLike);
    const received: unknown[] = [];
    session.onMessage((method, params) => received.push({ method, params }));
    await session.start();
    await session.start();
    for (const listener of messages) listener({}, "Runtime.consoleAPICalled", { type: "log" });
    expect(commands).toEqual(["Browser.getVersion"]);
    expect(received).toEqual([{ method: "Runtime.consoleAPICalled", params: { type: "log" } }]);
    await session.send("Page.enable");
    expect(commands).toEqual(["Browser.getVersion", "Page.enable"]);
  });
});
