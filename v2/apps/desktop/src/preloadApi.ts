import {
  RpcRequest,
  RpcResponse,
  RuntimeEventEnvelope,
  RuntimeProjection,
} from "@zli-v2/contracts";

type IpcBridge = {
  invoke(channel: string, payload?: unknown): Promise<unknown>;
  on(channel: string, listener: (event: unknown, value: unknown) => void): () => void;
};

export function createPreloadApi(ipc: IpcBridge) {
  return {
    runtime: {
      dispatch: async (request: unknown) => {
        const parsed = RpcRequest.parse(request);
        return RpcResponse.parse(await ipc.invoke("zli:runtime:dispatch", parsed));
      },
      getProjection: async () => {
        const projection = await ipc.invoke("zli:runtime:projection");
        return RuntimeProjection.parse(projection);
      },
      onEvent: (listener: (event: RuntimeEventEnvelope) => void) =>
        ipc.on("zli:runtime:event", (_event, value) => {
          const parsed = RuntimeEventEnvelope.safeParse(value);
          if (parsed.success) listener(parsed.data);
        }),
    },
    browser: {
      create: (input: unknown) => ipc.invoke("zli:browser:create", input),
      close: (browserTabId: string) => ipc.invoke("zli:browser:close", { browserTabId }),
      activate: (browserTabId: string) => ipc.invoke("zli:browser:activate", { browserTabId }),
      navigate: (browserTabId: string, url: string) => ipc.invoke("zli:browser:navigate", { browserTabId, url }),
      back: (browserTabId: string) => ipc.invoke("zli:browser:back", { browserTabId }),
      forward: (browserTabId: string) => ipc.invoke("zli:browser:forward", { browserTabId }),
      reload: (browserTabId: string, hard = false) => ipc.invoke("zli:browser:reload", { browserTabId, hard }),
      stop: (browserTabId: string) => ipc.invoke("zli:browser:stop", { browserTabId }),
    },
    dialog: {
      openProject: () => ipc.invoke("zli:dialog:open-project"),
    },
    menu: {
      trigger: (command: string) => ipc.invoke("zli:menu:trigger", { command }),
    },
    app: {
      getVersion: () => ipc.invoke("zli:app:version"),
      quit: () => ipc.invoke("zli:app:quit"),
    },
  };
}
