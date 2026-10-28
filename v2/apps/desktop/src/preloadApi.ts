import { ProjectionStore } from "@zli-v2/client-runtime";
import {
  BrowserBounds,
  BrowserDesignCaptureInput,
  BrowserDesignMarkInput,
  BrowserFillInput,
  BrowserNavigateInput,
  BrowserPressInput,
  BrowserReloadInput,
  BrowserRevealEvent,
  BrowserScreenshotInput,
  BrowserSelectorInput,
  BrowserSetBoundsInput,
  BrowserSetViewportInput,
  BrowserTabCreateInput,
  BrowserTabIdInput,
  BrowserTabProjection,
  type BrowserViewport,
  BrowserWaitForNetworkIdleInput,
  MobileAvdCreateInput,
  MobileAvdDeleteInput,
  MobileAvdList,
  MobileDevice,
  MobileDeviceIdInput,
  MobileLogLines,
  MobileOpenUrlResult,
  MobilePanelInput,
  MobilePanelLaunchInput,
  MobilePanelLogsInput,
  MobilePanelOpenUrlInput,
  MobilePopOutAspectInput,
  MobilePopOutList,
  MobilePopOutPinInput,
  MobileRevealEvent,
  MobileScreenshot,
  MobileSettings,
  MobileSetupPlan,
  MobileSetupProgress,
  MobileSetupRunInput,
  MobileSetupStatus,
  MobileStreamEvent,
  MobileStreamInfo,
  OpenInApp,
  OpenInRequest,
  RpcRequest,
  RpcResponse,
  RuntimeEventEnvelope,
  RuntimeProjection,
  TerminalAttachSnapshot,
  TerminalStreamMessage,
  UpdateStatus,
  WhatsNew,
} from "@zli-v2/contracts";

import {
  type NotificationSettings,
  parseNotificationSettings,
  parseNotificationSettingsPatch,
} from "./notifications/notificationSettings.js";

type IpcBridge = {
  invoke(channel: string, payload?: unknown): Promise<unknown>;
  on(channel: string, listener: (event: unknown, value: unknown) => void): () => void;
};

function createMobileApi(ipc: IpcBridge) {
  const device = (deviceId: string) => MobileDeviceIdInput.parse({ deviceId });
  const listen =
    <T>(channel: string, schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }) =>
    (listener: (value: T) => void) =>
      ipc.on(channel, (_event, value) => {
        const parsed = schema.safeParse(value);
        if (parsed.success) listener(parsed.data);
      });
  return {
    status: async (options: { recheckAcceleration?: boolean } = {}) =>
      MobileSetupStatus.parse(
        await ipc.invoke("zli:mobile:status", { recheckAcceleration: options.recheckAcceleration === true }),
      ),
    setupPlan: async () => MobileSetupPlan.parse(await ipc.invoke("zli:mobile:setup-plan")),
    setupProgress: async () => MobileSetupProgress.parse(await ipc.invoke("zli:mobile:setup-progress")),
    /** Resolves when setup ends; progress arrives through onSetupProgress meanwhile. */
    runSetup: async (acceptedLicenses: readonly string[]) => {
      await ipc.invoke("zli:mobile:setup-run", MobileSetupRunInput.parse({ acceptedLicenses: [...acceptedLicenses] }));
    },
    cancelSetup: async () => {
      await ipc.invoke("zli:mobile:setup-cancel");
    },
    onSetupProgress: listen("zli:mobile:setup", MobileSetupProgress),
    listAvds: async () => MobileAvdList.parse(await ipc.invoke("zli:mobile:avd-list")),
    createAvd: async (input: MobileAvdCreateInput) =>
      MobileAvdList.parse(await ipc.invoke("zli:mobile:avd-create", MobileAvdCreateInput.parse(input))),
    /** Refused while the device is booting or running. */
    deleteAvd: async (name: string) =>
      MobileAvdList.parse(await ipc.invoke("zli:mobile:avd-delete", MobileAvdDeleteInput.parse({ name }))),
    devices: async () => MobileDevice.array().parse(await ipc.invoke("zli:mobile:devices")),
    onDevices: listen("zli:mobile:devices", MobileDevice.array()),
    boot: async (deviceId: string) => MobileDevice.parse(await ipc.invoke("zli:mobile:boot", device(deviceId))),
    shutdown: async (deviceId: string) => {
      await ipc.invoke("zli:mobile:shutdown", device(deviceId));
    },
    startStream: async (deviceId: string) =>
      MobileStreamInfo.parse(await ipc.invoke("zli:mobile:stream-start", device(deviceId))),
    stopStream: async (deviceId: string) => {
      await ipc.invoke("zli:mobile:stream-stop", device(deviceId));
    },
    onStream: listen("zli:mobile:stream", MobileStreamEvent),
    input: async (input: MobilePanelInput) => {
      await ipc.invoke("zli:mobile:input", MobilePanelInput.parse(input));
    },
    /** Resolves with the localhost port forwarded to an Android device, when the URL needed one. */
    openUrl: async (deviceId: string, url: string) =>
      MobileOpenUrlResult.parse(
        await ipc.invoke("zli:mobile:open-url", MobilePanelOpenUrlInput.parse({ deviceId, url })),
      ),
    logs: async (deviceId: string, query: { appId?: string; lines?: number; filter?: string } = {}) =>
      MobileLogLines.parse(await ipc.invoke("zli:mobile:logs", MobilePanelLogsInput.parse({ ...query, deviceId }))),
    launch: async (deviceId: string, appId: string, options: { stop?: boolean } = {}) => {
      await ipc.invoke("zli:mobile:launch", MobilePanelLaunchInput.parse({ ...options, deviceId, appId }));
    },
    takeOver: async (deviceId: string) => {
      await ipc.invoke("zli:mobile:take-over", device(deviceId));
    },
    release: async (deviceId: string) => {
      await ipc.invoke("zli:mobile:release", device(deviceId));
    },
    screenshot: async (deviceId: string) =>
      MobileScreenshot.parse(await ipc.invoke("zli:mobile:screenshot", device(deviceId))),
    getSettings: async () => MobileSettings.parse(await ipc.invoke("zli:mobile:settings-get")),
    setSettings: async (patch: Partial<MobileSettings>) =>
      MobileSettings.parse(await ipc.invoke("zli:mobile:settings-set", MobileSettings.partial().parse(patch))),
    /** Fires when an agent boots or drives a device, so the renderer can show the Mobile panel with it. */
    onReveal: listen("zli:mobile:reveal", MobileRevealEvent),
    popOuts: async () => MobilePopOutList.parse(await ipc.invoke("zli:mobile:popout-list")),
    onPopOuts: listen("zli:mobile:popouts", MobilePopOutList),
    /** Opens the device in its own window, or focuses the window it already has. */
    popOut: async (deviceId: string) =>
      MobilePopOutList.parse(await ipc.invoke("zli:mobile:popout-open", device(deviceId))),
    closePopOut: async (deviceId: string) =>
      MobilePopOutList.parse(await ipc.invoke("zli:mobile:popout-close", device(deviceId))),
    pinPopOut: async (deviceId: string, pinned: boolean) =>
      MobilePopOutList.parse(
        await ipc.invoke("zli:mobile:popout-pin", MobilePopOutPinInput.parse({ deviceId, pinned })),
      ),
    setPopOutAspect: async (input: MobilePopOutAspectInput) => {
      await ipc.invoke("zli:mobile:popout-aspect", MobilePopOutAspectInput.parse(input));
    },
  };
}

/**
 * Keeps a copy of the main process projection by folding the events main forwards, so a streaming
 * agent costs one small IPC message per event instead of a structured clone and full validation of
 * the whole projection. Main sends the whole projection only when its own copy was replaced.
 */
function createProjectionMirror(ipc: IpcBridge) {
  const store = new ProjectionStore();
  const listeners = new Set<(projection: RuntimeProjection) => void>();
  let detach: (() => void) | undefined;
  let newestSequence = 0;
  let refreshing = false;

  const refresh = async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      // Events that arrive while the request is in flight can be newer than its answer.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const value = await ipc.invoke("zli:runtime:projection");
        if (value === null || value === undefined) return;
        const current = store.current();
        const parsed = RuntimeProjection.safeParse(value);
        if (!parsed.success) return;
        if (!current || parsed.data.lastSequence > current.lastSequence) store.replace(parsed.data);
        if ((store.current()?.lastSequence ?? 0) >= newestSequence) return;
      }
    } catch {
      // The next event that does not fold asks again.
    } finally {
      refreshing = false;
    }
  };

  const attach = () => {
    const unsubscribeStore = store.subscribe((projection) => {
      for (const listener of listeners) listener(projection);
    });
    const offProjection = ipc.on("zli:runtime:projection", (_event, value) => {
      try {
        store.replace(value);
      } catch {
        // Invalid projections from main are ignored.
      }
    });
    const offEvent = ipc.on("zli:runtime:projection-event", (_event, value) => {
      const parsed = RuntimeEventEnvelope.safeParse(value);
      if (!parsed.success) return;
      newestSequence = Math.max(newestSequence, parsed.data.sequence);
      if (store.apply(parsed.data) === "gap") void refresh();
    });
    return () => {
      unsubscribeStore();
      offProjection();
      offEvent();
    };
  };

  return {
    /** Keeps a fetched projection when it is newer, so the next event folds instead of refetching. */
    offer(projection: RuntimeProjection): RuntimeProjection {
      if (!detach) return projection;
      const current = store.current();
      if (current && current.lastSequence >= projection.lastSequence) return current;
      return store.replace(projection);
    },
    subscribe(listener: (projection: RuntimeProjection) => void): () => void {
      listeners.add(listener);
      detach ??= attach();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          detach?.();
          detach = undefined;
        }
      };
    },
  };
}

type CaptureSource = { id: string; name: string; kind: "window" | "screen"; thumbnail?: string };

function parseCaptureSources(value: unknown): CaptureSource[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const { id, name, kind, thumbnail } = (entry ?? {}) as Record<string, unknown>;
    if (typeof id !== "string" || typeof name !== "string" || (kind !== "window" && kind !== "screen")) return [];
    return [{ id, name, kind, ...(typeof thumbnail === "string" ? { thumbnail } : {}) }];
  });
}

function parseCapture(value: unknown): { name: string; dataBase64: string } {
  const { name, dataBase64 } = (value ?? {}) as Record<string, unknown>;
  if (typeof name !== "string" || typeof dataBase64 !== "string") throw new Error("The capture could not be read.");
  return { name, dataBase64 };
}

export function createPreloadApi(ipc: IpcBridge, options: { testMode?: boolean } = {}) {
  const projections = createProjectionMirror(ipc);
  const bridge = {
    runtime: {
      dispatch: async (request: unknown) => {
        const parsed = RpcRequest.parse(request);
        return RpcResponse.parse(await ipc.invoke("zli:runtime:dispatch", parsed));
      },
      getProjection: async () => {
        const projection = await ipc.invoke("zli:runtime:projection");
        return projection === null ? undefined : projections.offer(RuntimeProjection.parse(projection));
      },
      onProjection: (listener: (projection: RuntimeProjection) => void) => projections.subscribe(listener),
      attachTerminal: (terminalId: string, afterSequence = 0) =>
        ipc.invoke("zli:runtime:terminal:attach", { terminalId, afterSequence }),
      onTerminal: (
        listener: (message: { kind: "snapshot"; snapshot: unknown } | { kind: "stream"; message: unknown }) => void,
      ) =>
        ipc.on("zli:runtime:terminal", (_event, value) => {
          if (!value || typeof value !== "object" || !("kind" in value)) return;
          const message = value as { kind: unknown; snapshot?: unknown; message?: unknown };
          if (message.kind === "snapshot") {
            const parsed = TerminalAttachSnapshot.safeParse(message.snapshot);
            if (parsed.success) listener({ kind: "snapshot", snapshot: parsed.data });
          } else if (message.kind === "stream") {
            const parsed = TerminalStreamMessage.safeParse(message.message);
            if (parsed.success) listener({ kind: "stream", message: parsed.data });
          }
        }),
      onEvent: (listener: (event: RuntimeEventEnvelope) => void) =>
        ipc.on("zli:runtime:event", (_event, value) => {
          const parsed = RuntimeEventEnvelope.safeParse(value);
          if (parsed.success) listener(parsed.data);
        }),
    },
    browser: {
      create: async (input: unknown) =>
        BrowserTabProjection.parse(await ipc.invoke("zli:browser:create", BrowserTabCreateInput.parse(input))),
      close: (browserTabId: string) => ipc.invoke("zli:browser:close", BrowserTabIdInput.parse({ browserTabId })),
      activate: async (browserTabId: string) =>
        BrowserTabProjection.parse(await ipc.invoke("zli:browser:activate", BrowserTabIdInput.parse({ browserTabId }))),
      navigate: async (browserTabId: string, url: string) =>
        BrowserTabProjection.parse(
          await ipc.invoke("zli:browser:navigate", BrowserNavigateInput.parse({ browserTabId, url })),
        ),
      hide: async () => {
        await ipc.invoke("zli:browser:hide");
      },
      setBounds: (browserTabId: string, bounds: unknown) =>
        ipc.invoke(
          "zli:browser:set-bounds",
          BrowserSetBoundsInput.parse({ browserTabId, bounds: BrowserBounds.parse(bounds) }),
        ),
      back: (browserTabId: string) => ipc.invoke("zli:browser:back", BrowserTabIdInput.parse({ browserTabId })),
      forward: (browserTabId: string) => ipc.invoke("zli:browser:forward", BrowserTabIdInput.parse({ browserTabId })),
      reload: (browserTabId: string, hard = false) =>
        ipc.invoke("zli:browser:reload", BrowserReloadInput.parse({ browserTabId, hard })),
      stop: (browserTabId: string) => ipc.invoke("zli:browser:stop", BrowserTabIdInput.parse({ browserTabId })),
      openDevTools: (browserTabId: string) =>
        ipc.invoke("zli:browser:devtools", BrowserTabIdInput.parse({ browserTabId })),
      setViewport: async (browserTabId: string, viewport: BrowserViewport | null) =>
        BrowserTabProjection.parse(
          await ipc.invoke("zli:browser:set-viewport", BrowserSetViewportInput.parse({ browserTabId, viewport })),
        ),
      /** Fires when an agent opens a tab, so the renderer can show the Browser panel with that tab. */
      onReveal: (listener: (event: BrowserRevealEvent) => void) =>
        ipc.on("zli:browser:reveal", (_event, value) => {
          const parsed = BrowserRevealEvent.safeParse(value);
          if (parsed.success) listener(parsed.data);
        }),
      snapshot: (browserTabId: string) => ipc.invoke("zli:browser:snapshot", BrowserTabIdInput.parse({ browserTabId })),
      click: (input: { browserTabId: string; selector: string }) =>
        ipc.invoke("zli:browser:click", BrowserSelectorInput.parse(input)),
      fill: (input: { browserTabId: string; selector: string; value: string }) =>
        ipc.invoke("zli:browser:fill", BrowserFillInput.parse(input)),
      press: (input: { browserTabId: string; key: string }) =>
        ipc.invoke("zli:browser:press", BrowserPressInput.parse(input)),
      waitForNetworkIdle: (input: { browserTabId: string; idleMs?: number; timeoutMs?: number }) =>
        ipc.invoke("zli:browser:wait-network-idle", BrowserWaitForNetworkIdleInput.parse(input)),
      screenshot: (input: { browserTabId: string; format?: "png" | "jpeg" }) =>
        ipc.invoke("zli:browser:screenshot", BrowserScreenshotInput.parse(input)),
      inspectElement: (input: { browserTabId: string; selector: string }) =>
        ipc.invoke("zli:browser:inspect", BrowserSelectorInput.parse(input)),
      designInspect: (input: { browserTabId: string; selector: string }) =>
        ipc.invoke("zli:browser:design-inspect", BrowserSelectorInput.parse(input)),
      /**
       * Waits for the next element clicked or region drawn in the page's annotate session, starting
       * the session if needed; null when the session ends.
       */
      designPick: (browserTabId: string) =>
        ipc.invoke("zli:browser:design-pick", BrowserTabIdInput.parse({ browserTabId })),
      /** Ends the annotate session and removes its overlay from the page. */
      designCancel: (browserTabId: string) =>
        ipc.invoke("zli:browser:design-cancel", BrowserTabIdInput.parse({ browserTabId })),
      designMark: (input: { browserTabId: string; marks: unknown; drop?: unknown }) =>
        ipc.invoke("zli:browser:design-mark", BrowserDesignMarkInput.parse(input)),
      designCapture: (input: { browserTabId: string; bounds: unknown; strokes: unknown }) =>
        ipc.invoke("zli:browser:design-capture", BrowserDesignCaptureInput.parse(input)),
      consoleEntries: (browserTabId: string) =>
        ipc.invoke("zli:browser:console", BrowserTabIdInput.parse({ browserTabId })),
      networkEntries: (browserTabId: string) =>
        ipc.invoke("zli:browser:network", BrowserTabIdInput.parse({ browserTabId })),
    },
    mobile: createMobileApi(ipc),
    dialog: {
      openProject: () => ipc.invoke("zli:dialog:open-project"),
      saveSupportBundle: async () => {
        const path = await ipc.invoke("zli:dialog:save-support-bundle");
        return typeof path === "string" ? path : undefined;
      },
      openLegacySnapshot: async () => {
        const path = await ipc.invoke("zli:dialog:open-legacy-snapshot");
        return typeof path === "string" ? path : undefined;
      },
    },
    scratch: {
      /** The scratch chats folder, created on first use. */
      folder: async () => {
        const path = await ipc.invoke("zli:scratch:folder");
        return typeof path === "string" ? path : undefined;
      },
    },
    openIn: {
      /** Editors, agent apps, terminals, and the file manager found on this computer. */
      apps: async () => OpenInApp.array().parse(await ipc.invoke("zli:open-in:apps")),
      open: async (worktreeId: string, appId: string) => {
        await ipc.invoke("zli:open-in:open", OpenInRequest.parse({ worktreeId, appId }));
      },
    },
    capture: {
      sources: async () => parseCaptureSources(await ipc.invoke("zli:capture:sources")),
      take: async (id: string) => parseCapture(await ipc.invoke("zli:capture:take", { id })),
    },
    menu: {
      trigger: (command: string) => ipc.invoke("zli:menu:trigger", { command }),
    },
    app: {
      getVersion: () => ipc.invoke("zli:app:version"),
      quit: () => ipc.invoke("zli:app:quit"),
      openExternal: (url: string) => ipc.invoke("zli:app:open-external", { url }),
    },
    notifications: {
      getSettings: async () => parseNotificationSettings(await ipc.invoke("zli:notifications:get-settings")),
      setSettings: async (patch: Partial<NotificationSettings>) =>
        parseNotificationSettings(
          await ipc.invoke("zli:notifications:set-settings", parseNotificationSettingsPatch(patch)),
        ),
      /** Sessions whose tiles are on screen; main skips their alerts while the window has focus. */
      setViewing: (sessionIds: readonly string[]) =>
        ipc.invoke("zli:notifications:set-viewing", {
          sessionIds: sessionIds.filter((id) => typeof id === "string").slice(0, 200),
        }),
      /** Fires when the person clicks a notification, with the session to select. */
      onActivate: (listener: (event: { sessionId: string }) => void) =>
        ipc.on("zli:notifications:activate", (_event, value) => {
          const sessionId = (value as { sessionId?: unknown } | null)?.sessionId;
          if (typeof sessionId === "string" && sessionId.length > 0) listener({ sessionId });
        }),
      /** Fires when the person clicks an agent's request to connect a service, with its catalog id or server name. */
      onOpenConnector: (listener: (event: { connectorId: string }) => void) =>
        ipc.on("zli:connectors:open", (_event, value) => {
          const connectorId = (value as { connectorId?: unknown } | null)?.connectorId;
          if (typeof connectorId === "string" && connectorId.length > 0 && connectorId.length <= 100)
            listener({ connectorId });
        }),
    },
    updates: {
      getStatus: async () => UpdateStatus.parse(await ipc.invoke("zli:updates:get-status")),
      onStatus: (listener: (status: UpdateStatus) => void) =>
        ipc.on("zli:updates:status", (_event, value) => {
          const parsed = UpdateStatus.safeParse(value);
          if (parsed.success) listener(parsed.data);
        }),
      check: async () => UpdateStatus.parse(await ipc.invoke("zli:updates:check")),
      /** Downloads the offered update, or opens its release page where ZLI cannot install it. */
      download: async () => UpdateStatus.parse(await ipc.invoke("zli:updates:download")),
      /** Restarts ZLI into the downloaded update. Resolves false when none is ready. */
      quitAndInstall: async () => (await ipc.invoke("zli:updates:install")) === true,
      openReleasePage: async () => {
        await ipc.invoke("zli:updates:open-release");
      },
      setAutoInstall: async (autoInstall: boolean) =>
        UpdateStatus.parse(await ipc.invoke("zli:updates:set-auto-install", { autoInstall: autoInstall === true })),
      /** The release this launch was updated to, once, or undefined. */
      whatsNew: async () => {
        const parsed = WhatsNew.safeParse(await ipc.invoke("zli:updates:whats-new"));
        return parsed.success ? parsed.data : undefined;
      },
      dismissWhatsNew: async () => {
        await ipc.invoke("zli:updates:dismiss-whats-new");
      },
    },
  };
  return options.testMode
    ? {
        ...bridge,
        test: {
          restartRuntime: () => ipc.invoke("zli:test:restart-runtime"),
          crashMain: () => ipc.invoke("zli:test:crash-main"),
          takeExternalUrl: () => ipc.invoke("zli:test:take-external-url"),
          takeOpenIn: () => ipc.invoke("zli:test:take-open-in"),
        },
      }
    : bridge;
}
