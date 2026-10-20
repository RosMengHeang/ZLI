import type {
  BrowserTabProjection,
  BrowserViewport,
  RpcResponse,
  RuntimeProjection,
  TerminalAttachSnapshot,
  TerminalStreamMessage,
} from "@zli-v2/contracts";

export type ZliBridge = {
  runtime: {
    dispatch(request: unknown): Promise<RpcResponse>;
    getProjection(): Promise<RuntimeProjection | undefined>;
    onProjection(listener: (projection: RuntimeProjection) => void): () => void;
    attachTerminal(terminalId: string, afterSequence?: number): Promise<unknown>;
    onTerminal(
      listener: (
        message:
          | { kind: "snapshot"; snapshot: TerminalAttachSnapshot }
          | { kind: "stream"; message: TerminalStreamMessage },
      ) => void,
    ): () => void;
  };
  browser: {
    create(input: unknown): Promise<BrowserTabProjection>;
    close(browserTabId: string): Promise<void>;
    activate(browserTabId: string): Promise<BrowserTabProjection>;
    navigate(browserTabId: string, url: string): Promise<BrowserTabProjection>;
    hide(): Promise<void>;
    setBounds(browserTabId: string, bounds: unknown): Promise<void>;
    back(browserTabId: string): Promise<void>;
    forward(browserTabId: string): Promise<void>;
    reload(browserTabId: string, hard?: boolean): Promise<void>;
    stop(browserTabId: string): Promise<void>;
    openDevTools(browserTabId: string): Promise<void>;
    setViewport(browserTabId: string, viewport: BrowserViewport | null): Promise<BrowserTabProjection>;
    onReveal(listener: (event: { browserTabId: string; worktreeId: string }) => void): () => void;
    snapshot(browserTabId: string): Promise<unknown>;
    click(input: unknown): Promise<void>;
    fill(input: unknown): Promise<void>;
    press(input: unknown): Promise<void>;
    waitForNetworkIdle(input: unknown): Promise<{ idle: boolean }>;
    screenshot(input: unknown): Promise<unknown>;
    inspectElement(input: unknown): Promise<unknown>;
    designInspect(input: unknown): Promise<unknown>;
    consoleEntries(browserTabId: string): Promise<readonly unknown[]>;
    networkEntries(browserTabId: string): Promise<readonly unknown[]>;
  };
  dialog: {
    openProject(): Promise<string | undefined>;
    saveSupportBundle(): Promise<string | undefined>;
    openLegacySnapshot(): Promise<string | undefined>;
  };
  menu: { trigger(command: string): Promise<unknown> };
  app: { getVersion(): Promise<string>; quit(): Promise<void> };
  test?: { restartRuntime(): Promise<unknown>; crashMain(): Promise<unknown> };
};

declare global {
  interface Window {
    zli?: ZliBridge;
  }
}

export function getBridge(): ZliBridge | undefined {
  return typeof window === "undefined" ? undefined : window.zli;
}
