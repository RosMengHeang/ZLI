import {
  BrowserBounds,
  BrowserFillInput,
  BrowserNavigateInput,
  BrowserPressInput,
  BrowserReloadInput,
  BrowserRevealEvent,
  BrowserSetBoundsInput,
  BrowserSetViewportInput,
  BrowserScreenshotInput,
  BrowserSelectorInput,
  BrowserTabCreateInput,
  BrowserTabIdInput,
  BrowserTabProjection,
  BrowserWaitForNetworkIdleInput,
  RpcRequest,
  RpcResponse,
  RuntimeEventEnvelope,
  RuntimeProjection,
  type BrowserViewport,
  TerminalAttachSnapshot,
  TerminalStreamMessage,
} from "@zli-v2/contracts";

type IpcBridge = {
  invoke(channel: string, payload?: unknown): Promise<unknown>;
  on(channel: string, listener: (event: unknown, value: unknown) => void): () => void;
};

export function createPreloadApi(ipc: IpcBridge, options: { testMode?: boolean } = {}) {
  const bridge = {
    runtime: {
      dispatch: async (request: unknown) => {
        const parsed = RpcRequest.parse(request);
        return RpcResponse.parse(await ipc.invoke("zli:runtime:dispatch", parsed));
      },
      getProjection: async () => {
        const projection = await ipc.invoke("zli:runtime:projection");
        return projection === null ? undefined : RuntimeProjection.parse(projection);
      },
      onProjection: (listener: (projection: RuntimeProjection) => void) =>
        ipc.on("zli:runtime:projection", (_event, value) => {
          const parsed = RuntimeProjection.safeParse(value);
          if (parsed.success) listener(parsed.data);
        }),
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
      consoleEntries: (browserTabId: string) =>
        ipc.invoke("zli:browser:console", BrowserTabIdInput.parse({ browserTabId })),
      networkEntries: (browserTabId: string) =>
        ipc.invoke("zli:browser:network", BrowserTabIdInput.parse({ browserTabId })),
    },
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
    menu: {
      trigger: (command: string) => ipc.invoke("zli:menu:trigger", { command }),
    },
    app: {
      getVersion: () => ipc.invoke("zli:app:version"),
      quit: () => ipc.invoke("zli:app:quit"),
    },
  };
  return options.testMode
    ? {
        ...bridge,
        test: {
          restartRuntime: () => ipc.invoke("zli:test:restart-runtime"),
          crashMain: () => ipc.invoke("zli:test:crash-main"),
        },
      }
    : bridge;
}
