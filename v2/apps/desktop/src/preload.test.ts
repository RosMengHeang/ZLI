import { describe, expect, it } from "vitest";

import { createPreloadApi } from "./preloadApi.js";

describe("preload API", () => {
  it("exposes fixed capabilities instead of raw ipcRenderer methods", async () => {
    const calls: Array<{ channel: string; payload: unknown }> = [];
    const listeners = new Map<string, (event: unknown, value: unknown) => void>();
    const api = createPreloadApi({
      invoke: async (channel, payload) => {
        calls.push({ channel, payload });
        return {
          accepted: true,
          commandId: payload && typeof payload === "object" ? (payload as { commandId?: string }).commandId : undefined,
        };
      },
      on: (channel, listener) => {
        listeners.set(channel, listener);
        return () => listeners.delete(channel);
      },
    });
    await api.runtime.dispatch({
      protocolVersion: 1,
      commandId: "00000000-0000-4000-8000-000000000901",
      command: { type: "runtime.getProjection" },
    });
    const unsubscribe = api.runtime.onEvent(() => undefined);
    unsubscribe();
    expect(calls[0]?.channel).toBe("zli:runtime:dispatch");
    expect(Object.keys(api.runtime)).toEqual([
      "dispatch",
      "getProjection",
      "onProjection",
      "attachTerminal",
      "onTerminal",
      "onEvent",
    ]);
    expect("send" in api).toBe(false);
  });

  it("exposes crash injection only through the test-mode API", async () => {
    const calls: string[] = [];
    const ipc = {
      invoke: async (channel: string) => {
        calls.push(channel);
        return { accepted: true };
      },
      on: () => () => undefined,
    };
    const testApi = createPreloadApi(ipc, { testMode: true });
    const productionApi = createPreloadApi(ipc);

    await (testApi as typeof testApi & { test: { crashMain(): Promise<unknown> } }).test.crashMain();

    expect(calls).toEqual(["zli:test:crash-main"]);
    expect("test" in productionApi).toBe(false);
  });
});
