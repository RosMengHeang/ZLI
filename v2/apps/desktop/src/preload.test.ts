import { describe, expect, it, vi } from "vitest";

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

  it("keeps the projection current from forwarded events and refetches it after a gap", async () => {
    const environmentId = "00000000-0000-4000-8000-000000000001";
    const projectionAt = (lastSequence: number, browserTabs: unknown[] = []) => ({
      environment: { environmentId, label: "Local", protocolVersion: 1, capabilities: {} },
      projects: [],
      worktrees: [],
      threads: [],
      terminals: [],
      browserTabs,
      attention: [],
      lastSequence,
    });
    const tab = {
      browserTabId: "00000000-0000-4000-8000-000000000010",
      profileId: "00000000-0000-4000-8000-000000000002",
      worktreeId: "00000000-0000-4000-8000-000000000011",
      url: "about:blank",
      title: "",
      active: true,
      status: "idle",
    };
    const event = (sequence: number, value: unknown) => ({
      protocolVersion: 1,
      sequence,
      eventId: `00000000-0000-4000-8000-0000000009${String(sequence).padStart(2, "0")}`,
      occurredAt: "2026-09-21T00:00:00.000Z",
      event: value,
    });
    const invoked: string[] = [];
    let mainProjection: unknown = projectionAt(5, [tab]);
    const listeners = new Map<string, (event: unknown, value: unknown) => void>();
    const api = createPreloadApi({
      invoke: async (channel) => {
        invoked.push(channel);
        return mainProjection;
      },
      on: (channel, listener) => {
        listeners.set(channel, listener);
        return () => listeners.delete(channel);
      },
    });
    const seen: Array<{ lastSequence: number; tabs: number }> = [];
    const unsubscribe = api.runtime.onProjection((projection) =>
      seen.push({ lastSequence: projection.lastSequence, tabs: projection.browserTabs.length }),
    );

    listeners.get("zli:runtime:projection")?.({}, projectionAt(1));
    listeners.get("zli:runtime:projection-event")?.({}, event(2, { type: "browser.updated", tab }));
    expect(seen).toEqual([
      { lastSequence: 1, tabs: 0 },
      { lastSequence: 2, tabs: 1 },
    ]);
    expect(invoked).toEqual([]);

    listeners.get("zli:runtime:projection-event")?.({}, event(5, { type: "browser.updated", tab }));
    await vi.waitFor(() => expect(seen.at(-1)).toEqual({ lastSequence: 5, tabs: 1 }));
    expect(invoked).toEqual(["zli:runtime:projection"]);

    mainProjection = projectionAt(6);
    listeners.get("zli:runtime:projection-event")?.(
      {},
      event(6, { type: "browser.closed", browserTabId: tab.browserTabId }),
    );
    expect(seen.at(-1)).toEqual({ lastSequence: 6, tabs: 0 });
    unsubscribe();
    expect(listeners.has("zli:runtime:projection")).toBe(false);
    expect(listeners.has("zli:runtime:projection-event")).toBe(false);
  });

  it("folds events onto the projection the renderer fetched first", async () => {
    const environmentId = "00000000-0000-4000-8000-000000000001";
    const projectionAt = (lastSequence: number) => ({
      environment: { environmentId, label: "Local", protocolVersion: 1, capabilities: {} },
      projects: [],
      worktrees: [],
      threads: [],
      terminals: [],
      browserTabs: [],
      attention: [],
      lastSequence,
    });
    const tab = {
      browserTabId: "00000000-0000-4000-8000-000000000010",
      profileId: "00000000-0000-4000-8000-000000000002",
      worktreeId: "00000000-0000-4000-8000-000000000011",
      url: "about:blank",
      title: "",
      active: true,
      status: "idle",
    };
    let mainProjection: unknown = projectionAt(3);
    const invoked: string[] = [];
    const listeners = new Map<string, (event: unknown, value: unknown) => void>();
    const api = createPreloadApi({
      invoke: async (channel) => {
        invoked.push(channel);
        return mainProjection;
      },
      on: (channel, listener) => {
        listeners.set(channel, listener);
        return () => listeners.delete(channel);
      },
    });
    const seen: number[] = [];
    const unsubscribe = api.runtime.onProjection((projection) => seen.push(projection.lastSequence));

    expect((await api.runtime.getProjection())?.lastSequence).toBe(3);
    listeners.get("zli:runtime:projection-event")?.(
      {},
      {
        protocolVersion: 1,
        sequence: 4,
        eventId: "00000000-0000-4000-8000-000000000904",
        occurredAt: "2026-09-21T00:00:00.000Z",
        event: { type: "browser.updated", tab },
      },
    );
    expect(seen.at(-1)).toBe(4);
    expect(invoked).toEqual(["zli:runtime:projection"]);

    mainProjection = projectionAt(2);
    expect((await api.runtime.getProjection())?.lastSequence).toBe(4);
    unsubscribe();
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

  it("sends only known notification settings and delivers valid activation events", async () => {
    const calls: Array<{ channel: string; payload: unknown }> = [];
    const listeners = new Map<string, (event: unknown, value: unknown) => void>();
    const api = createPreloadApi({
      invoke: async (channel, payload) => {
        calls.push({ channel, payload });
        return { enabled: false, sound: true };
      },
      on: (channel, listener) => {
        listeners.set(channel, listener);
        return () => listeners.delete(channel);
      },
    });

    expect(await api.notifications.setSettings({ enabled: false, extra: true } as never)).toEqual({
      enabled: false,
      sound: true,
    });
    await api.notifications.setViewing(["s1", 4 as never]);
    expect(calls).toEqual([
      { channel: "zli:notifications:set-settings", payload: { enabled: false } },
      { channel: "zli:notifications:set-viewing", payload: { sessionIds: ["s1"] } },
    ]);

    const activated: unknown[] = [];
    const unsubscribe = api.notifications.onActivate((event) => activated.push(event));
    listeners.get("zli:notifications:activate")?.({}, { sessionId: "s1" });
    listeners.get("zli:notifications:activate")?.({}, { sessionId: 7 });
    listeners.get("zli:notifications:activate")?.({}, null);
    expect(activated).toEqual([{ sessionId: "s1" }]);
    unsubscribe();
    expect(listeners.has("zli:notifications:activate")).toBe(false);

    const connectors: unknown[] = [];
    api.notifications.onOpenConnector((event) => connectors.push(event));
    listeners.get("zli:connectors:open")?.({}, { connectorId: "github" });
    listeners.get("zli:connectors:open")?.({}, { connectorId: 3 });
    expect(connectors).toEqual([{ connectorId: "github" }]);
  });

  it("passes only valid reach questions and answers", async () => {
    const calls: Array<{ channel: string; payload: unknown }> = [];
    const listeners = new Map<string, (event: unknown, value: unknown) => void>();
    const request = {
      requestId: "00000000-0000-4000-8000-000000000001",
      agent: "Bob",
      project: "collect",
      target: { agent: "Kim", project: "web" },
    };
    const api = createPreloadApi({
      invoke: async (channel, payload) => {
        calls.push({ channel, payload });
        return channel === "zli:agents:reach-current" ? request : undefined;
      },
      on: (channel, listener) => {
        listeners.set(channel, listener);
        return () => listeners.delete(channel);
      },
    });

    expect(await api.agentReach.current()).toEqual(request);
    await api.agentReach.answer({ requestId: request.requestId, allow: true, extra: 1 } as never);
    await expect(api.agentReach.answer({ requestId: "nope", allow: true })).rejects.toThrow();
    expect(calls.at(-1)).toEqual({
      channel: "zli:agents:reach-answer",
      payload: { requestId: request.requestId, allow: true },
    });

    const seen: unknown[] = [];
    api.agentReach.onRequest((value) => seen.push(value));
    listeners.get("zli:agents:reach-request")?.({}, request);
    listeners.get("zli:agents:reach-request")?.({}, { requestId: "bad" });
    listeners.get("zli:agents:reach-request")?.({}, null);
    expect(seen).toEqual([request, undefined]);
  });

  it("validates update status from main and sends only a boolean auto-install setting", async () => {
    const calls: Array<{ channel: string; payload: unknown }> = [];
    const listeners = new Map<string, (event: unknown, value: unknown) => void>();
    const status = {
      state: { status: "ready", version: "0.2.0", notes: "Faster startup" },
      currentVersion: "0.1.9",
      autoInstall: true,
      channel: "stable",
    };
    const api = createPreloadApi({
      invoke: async (channel, payload) => {
        calls.push({ channel, payload });
        if (channel === "zli:updates:install") return true;
        if (channel === "zli:updates:whats-new") return { version: "0.2.0", releaseUrl: "not a url" };
        return status;
      },
      on: (channel, listener) => {
        listeners.set(channel, listener);
        return () => listeners.delete(channel);
      },
    });

    expect(await api.updates.getStatus()).toEqual(status);
    await api.updates.setAutoInstall("yes" as never);
    expect(await api.updates.quitAndInstall()).toBe(true);
    expect(await api.updates.whatsNew()).toBeUndefined();
    expect(calls.map((call) => call.channel)).toEqual([
      "zli:updates:get-status",
      "zli:updates:set-auto-install",
      "zli:updates:install",
      "zli:updates:whats-new",
    ]);
    expect(calls[1]?.payload).toEqual({ autoInstall: false });

    const received: unknown[] = [];
    const unsubscribe = api.updates.onStatus((next) => received.push(next));
    listeners.get("zli:updates:status")?.(
      {},
      { ...status, state: { status: "downloading", version: "0.2.0", percent: 40 } },
    );
    listeners.get("zli:updates:status")?.({}, { state: { status: "exploded" } });
    expect(received).toHaveLength(1);
    unsubscribe();
    expect(listeners.has("zli:updates:status")).toBe(false);
  });

  it("hides native browser views through a dedicated channel", async () => {
    const calls: Array<{ channel: string; payload: unknown }> = [];
    const api = createPreloadApi({
      invoke: async (channel, payload) => {
        calls.push({ channel, payload });
        return undefined;
      },
      on: () => () => undefined,
    });

    await api.browser.hide();

    expect(calls).toEqual([{ channel: "zli:browser:hide", payload: undefined }]);
  });

  it("sets device viewports and delivers valid reveal events", async () => {
    const calls: Array<{ channel: string; payload: unknown }> = [];
    const listeners = new Map<string, (event: unknown, value: unknown) => void>();
    const browserTabId = "00000000-0000-4000-8000-000000000010";
    const worktreeId = "00000000-0000-4000-8000-000000000011";
    const api = createPreloadApi({
      invoke: async (channel, payload) => {
        calls.push({ channel, payload });
        return {
          browserTabId,
          profileId: "00000000-0000-4000-8000-000000000002",
          worktreeId,
          url: "about:blank",
          title: "",
          active: true,
          status: "idle",
        };
      },
      on: (channel, listener) => {
        listeners.set(channel, listener);
        return () => listeners.delete(channel);
      },
    });

    const viewport = { preset: "iphone-15", width: 393, height: 852, deviceScaleFactor: 3, mobile: true };
    await api.browser.setViewport(browserTabId, viewport);
    await api.browser.setViewport(browserTabId, null);
    expect(calls).toEqual([
      { channel: "zli:browser:set-viewport", payload: { browserTabId, viewport } },
      { channel: "zli:browser:set-viewport", payload: { browserTabId, viewport: null } },
    ]);

    const reveals: unknown[] = [];
    const unsubscribe = api.browser.onReveal((event) => reveals.push(event));
    listeners.get("zli:browser:reveal")?.({}, { browserTabId, worktreeId });
    listeners.get("zli:browser:reveal")?.({}, { browserTabId: "not-a-tab" });
    expect(reveals).toEqual([{ browserTabId, worktreeId }]);
    unsubscribe();
    expect(listeners.has("zli:browser:reveal")).toBe(false);
  });
});

describe("preload mobile API", () => {
  it("validates device ids before invoking main and passes valid stream events through", async () => {
    const calls: Array<{ channel: string; payload: unknown }> = [];
    const listeners = new Map<string, (event: unknown, value: unknown) => void>();
    const api = createPreloadApi({
      invoke: async (channel, payload) => {
        calls.push({ channel, payload });
        return channel === "zli:mobile:stream-start" ? { deviceId: "ios:1", mode: "stills", width: 0, height: 0 } : {};
      },
      on: (channel, listener) => {
        listeners.set(channel, listener);
        return () => listeners.delete(channel);
      },
    });
    expect(await api.mobile.startStream("ios:1")).toEqual({ deviceId: "ios:1", mode: "stills", width: 0, height: 0 });
    expect(calls).toEqual([{ channel: "zli:mobile:stream-start", payload: { deviceId: "ios:1" } }]);
    await expect(api.mobile.takeOver("")).rejects.toThrow();
    await expect(
      api.mobile.input({ deviceId: "ios:1", type: "touch", action: "down", x: -5, y: 0 } as never),
    ).rejects.toThrow();
    expect(calls).toHaveLength(1);

    const events: unknown[] = [];
    api.mobile.onStream((event) => events.push(event));
    const emit = listeners.get("zli:mobile:stream");
    const frame = { type: "frame", deviceId: "android:1", key: true, timestamp: 1, data: new Uint8Array([0, 0, 1]) };
    emit?.(undefined, frame);
    emit?.(undefined, { type: "frame", deviceId: "android:1", key: true, timestamp: 1, data: "not bytes" });
    emit?.(undefined, { type: "ended", deviceId: "android:1", reason: "The panel stopped showing this device." });
    expect(events).toEqual([
      frame,
      { type: "ended", deviceId: "android:1", reason: "The panel stopped showing this device." },
    ]);
  });

  it("validates Open URL, Logs, and Launch before invoking main and parses their answers", async () => {
    const calls: Array<{ channel: string; payload: unknown }> = [];
    const api = createPreloadApi({
      invoke: async (channel, payload) => {
        calls.push({ channel, payload });
        if (channel === "zli:mobile:open-url") return { reversedPort: 8081 };
        if (channel === "zli:mobile:logs") return ["I/zli: ready"];
        return { accepted: true };
      },
      on: () => () => undefined,
    });
    expect(await api.mobile.openUrl("android:1", "exp://localhost:8081")).toEqual({ reversedPort: 8081 });
    expect(await api.mobile.logs("android:1", { filter: "zli", lines: 50 })).toEqual(["I/zli: ready"]);
    await api.mobile.launch("android:1", "com.example.app", { stop: true });
    expect(calls).toEqual([
      { channel: "zli:mobile:open-url", payload: { deviceId: "android:1", url: "exp://localhost:8081" } },
      { channel: "zli:mobile:logs", payload: { deviceId: "android:1", filter: "zli", lines: 50 } },
      { channel: "zli:mobile:launch", payload: { deviceId: "android:1", appId: "com.example.app", stop: true } },
    ]);

    await expect(api.mobile.openUrl("android:1", "")).rejects.toThrow();
    await expect(api.mobile.logs("android:1", { lines: 0 })).rejects.toThrow();
    await expect(api.mobile.logs("android:1", { appId: "a b" })).rejects.toThrow();
    await expect(api.mobile.launch("android:1", "com.example; reboot")).rejects.toThrow();
    expect(calls).toHaveLength(3);
  });

  it("validates virtual device names and images before invoking main and parses the device list", async () => {
    const calls: Array<{ channel: string; payload: unknown }> = [];
    const list = {
      avdmanager: true,
      avds: [{ name: "Pixel_9", displayName: "Pixel 9", systemImage: "system-images;android-35;google_apis;x86_64" }],
      systemImages: ["system-images;android-35;google_apis;x86_64"],
      deviceProfiles: [{ id: "pixel_7", name: "Pixel 7" }],
      defaultDeviceProfile: "pixel_7",
    };
    const api = createPreloadApi({
      invoke: async (channel, payload) => {
        calls.push({ channel, payload });
        return channel === "zli:mobile:avd-delete" ? { ...list, avds: [] } : list;
      },
      on: () => () => undefined,
    });
    expect(await api.mobile.listAvds()).toEqual(list);
    const image = "system-images;android-35;google_apis;x86_64";
    expect(await api.mobile.createAvd({ name: "Pixel_9", systemImage: image, device: "pixel_7" })).toEqual(list);
    expect((await api.mobile.deleteAvd("Pixel_9")).avds).toEqual([]);
    expect(calls).toEqual([
      { channel: "zli:mobile:avd-list", payload: undefined },
      { channel: "zli:mobile:avd-create", payload: { name: "Pixel_9", systemImage: image, device: "pixel_7" } },
      { channel: "zli:mobile:avd-delete", payload: { name: "Pixel_9" } },
    ]);

    await expect(api.mobile.createAvd({ name: "Pixel 9", systemImage: image })).rejects.toThrow();
    await expect(api.mobile.createAvd({ name: "Pixel_9", systemImage: "android-35" })).rejects.toThrow();
    await expect(api.mobile.deleteAvd("../Pixel_9")).rejects.toThrow();
    expect(calls).toHaveLength(3);
  });

  it("validates pop-out window requests and drops malformed pop-out events", async () => {
    const calls: Array<{ channel: string; payload: unknown }> = [];
    const listeners = new Map<string, (event: unknown, value: unknown) => void>();
    const pixel = "android-avd:Pixel_8";
    const api = createPreloadApi({
      invoke: async (channel, payload) => {
        calls.push({ channel, payload });
        if (channel === "zli:mobile:popout-close") return [];
        if (channel === "zli:mobile:popout-aspect") return { accepted: true };
        return [{ deviceId: pixel, pinned: channel === "zli:mobile:popout-pin" }];
      },
      on: (channel, listener) => {
        listeners.set(channel, listener);
        return () => listeners.delete(channel);
      },
    });
    expect(await api.mobile.popOut(pixel)).toEqual([{ deviceId: pixel, pinned: false }]);
    expect(await api.mobile.pinPopOut(pixel, true)).toEqual([{ deviceId: pixel, pinned: true }]);
    await api.mobile.setPopOutAspect({ deviceId: pixel, aspect: 0.47, extraWidth: 24, extraHeight: 96 });
    expect(await api.mobile.closePopOut(pixel)).toEqual([]);
    expect(await api.mobile.popOuts()).toEqual([{ deviceId: pixel, pinned: false }]);
    expect(calls).toEqual([
      { channel: "zli:mobile:popout-open", payload: { deviceId: pixel } },
      { channel: "zli:mobile:popout-pin", payload: { deviceId: pixel, pinned: true } },
      {
        channel: "zli:mobile:popout-aspect",
        payload: { deviceId: pixel, aspect: 0.47, extraWidth: 24, extraHeight: 96 },
      },
      { channel: "zli:mobile:popout-close", payload: { deviceId: pixel } },
      { channel: "zli:mobile:popout-list", payload: undefined },
    ]);
    await expect(api.mobile.popOut("")).rejects.toThrow();
    await expect(api.mobile.pinPopOut(pixel, "yes" as never)).rejects.toThrow();
    await expect(
      api.mobile.setPopOutAspect({ deviceId: pixel, aspect: -1, extraWidth: 0, extraHeight: 0 }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(5);

    const changes: unknown[] = [];
    api.mobile.onPopOuts((popOuts) => changes.push(popOuts));
    const emit = listeners.get("zli:mobile:popouts");
    emit?.(undefined, [{ deviceId: pixel, pinned: true }]);
    emit?.(undefined, [{ deviceId: pixel }]);
    expect(changes).toEqual([[{ deviceId: pixel, pinned: true }]]);
  });
});
