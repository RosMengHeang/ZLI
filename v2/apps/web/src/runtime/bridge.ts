import type {
  BrowserTabProjection,
  BrowserViewport,
  MobileAvdCreateInput,
  MobileAvdList,
  MobileDevice,
  MobileOpenUrlResult,
  MobilePanelInput,
  MobilePopOut,
  MobilePopOutAspectInput,
  MobileRevealEvent,
  MobileScreenshot,
  MobileSettings,
  MobileSetupPlan,
  MobileSetupProgress,
  MobileSetupStatus,
  MobileStreamEvent,
  MobileStreamInfo,
  OpenInApp,
  RpcResponse,
  RuntimeProjection,
  TerminalAttachSnapshot,
  TerminalStreamMessage,
  UpdateStatus,
  WhatsNew,
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
    /**
     * Resolves with the next element clicked or region drawn in the page's annotate session,
     * starting the session if needed, or null when the session ends.
     */
    designPick?(browserTabId: string): Promise<unknown>;
    /** Ends the annotate session and removes its overlay from the page. */
    designCancel?(browserTabId: string): Promise<unknown>;
    /** Draws numbered markers for the annotations on the page. */
    designMark?(input: { browserTabId: string; marks: unknown }): Promise<unknown>;
    /** A screenshot of a drawn region with its sketch on top. */
    designCapture?(input: { browserTabId: string; bounds: unknown; strokes: unknown }): Promise<unknown>;
    /** Shows a text or style change on the live page only; a null preview puts the element back. */
    designPreview?(input: { browserTabId: string; selector: string; preview: unknown }): Promise<unknown>;
    consoleEntries(browserTabId: string): Promise<readonly unknown[]>;
    networkEntries(browserTabId: string): Promise<readonly unknown[]>;
  };
  /** Present in the desktop app, which runs the emulators and simulators. */
  mobile?: MobileBridge;
  dialog: {
    openProject(): Promise<string | undefined>;
    saveSupportBundle(): Promise<string | undefined>;
    openLegacySnapshot(): Promise<string | undefined>;
  };
  scratch?: { folder(): Promise<string | undefined> };
  /** Present in the desktop app, which can start other apps on a worktree folder. */
  openIn?: { apps(): Promise<OpenInApp[]>; open(worktreeId: string, appId: string): Promise<void> };
  capture?: {
    sources(): Promise<CaptureSource[]>;
    take(id: string): Promise<{ name: string; dataBase64: string }>;
  };
  menu: { trigger(command: string): Promise<unknown> };
  app: { getVersion(): Promise<string>; quit(): Promise<void>; openExternal?(url: string): Promise<unknown> };
  test?: {
    restartRuntime(): Promise<unknown>;
    crashMain(): Promise<unknown>;
    takeExternalUrl?(): Promise<unknown>;
    takeOpenIn?(): Promise<unknown>;
  };
  notifications?: {
    getSettings(): Promise<NotificationSettings>;
    setSettings(patch: Partial<NotificationSettings>): Promise<NotificationSettings>;
    setViewing(sessionIds: readonly string[]): Promise<unknown>;
    onActivate(listener: (event: { sessionId: string }) => void): () => void;
    /** Fires when the person clicks an agent's request to connect a service. */
    onOpenConnector?(listener: (event: { connectorId: string }) => void): () => void;
  };
  updates?: {
    getStatus(): Promise<UpdateStatus>;
    onStatus(listener: (status: UpdateStatus) => void): () => void;
    check(): Promise<UpdateStatus>;
    download(): Promise<UpdateStatus>;
    quitAndInstall(): Promise<boolean>;
    openReleasePage(): Promise<void>;
    setAutoInstall(autoInstall: boolean): Promise<UpdateStatus>;
    whatsNew(): Promise<WhatsNew | undefined>;
    dismissWhatsNew(): Promise<void>;
  };
};

export type MobileBridge = {
  status(options?: { recheckAcceleration?: boolean }): Promise<MobileSetupStatus>;
  setupPlan(): Promise<MobileSetupPlan>;
  setupProgress(): Promise<MobileSetupProgress>;
  runSetup(acceptedLicenses: readonly string[]): Promise<void>;
  cancelSetup(): Promise<void>;
  onSetupProgress(listener: (progress: MobileSetupProgress) => void): () => void;
  /** Android virtual devices, the installed system images, and the hardware profiles to create one with. */
  listAvds(): Promise<MobileAvdList>;
  createAvd(input: MobileAvdCreateInput): Promise<MobileAvdList>;
  /** Refused while the device is booting or running. */
  deleteAvd(name: string): Promise<MobileAvdList>;
  devices(): Promise<MobileDevice[]>;
  onDevices(listener: (devices: MobileDevice[]) => void): () => void;
  boot(deviceId: string): Promise<MobileDevice>;
  shutdown(deviceId: string): Promise<void>;
  startStream(deviceId: string): Promise<MobileStreamInfo>;
  stopStream(deviceId: string): Promise<void>;
  onStream(listener: (event: MobileStreamEvent) => void): () => void;
  input(input: MobilePanelInput): Promise<void>;
  /** Refused while an agent holds the device, like input. */
  openUrl(deviceId: string, url: string): Promise<MobileOpenUrlResult>;
  logs(deviceId: string, query?: { appId?: string; lines?: number; filter?: string }): Promise<string[]>;
  launch(deviceId: string, appId: string, options?: { stop?: boolean }): Promise<void>;
  takeOver(deviceId: string): Promise<void>;
  release(deviceId: string): Promise<void>;
  screenshot(deviceId: string): Promise<MobileScreenshot>;
  getSettings(): Promise<MobileSettings>;
  setSettings(patch: Partial<MobileSettings>): Promise<MobileSettings>;
  onReveal(listener: (event: MobileRevealEvent) => void): () => void;
  /** Pop-out windows exist only in the desktop app; without them the panel offers no Pop out. */
  popOuts?(): Promise<MobilePopOut[]>;
  onPopOuts?(listener: (popOuts: MobilePopOut[]) => void): () => void;
  /** Opens the device in its own window, or focuses the window it already has. */
  popOut?(deviceId: string): Promise<MobilePopOut[]>;
  closePopOut?(deviceId: string): Promise<MobilePopOut[]>;
  /** Keeps the device's window above other windows. */
  pinPopOut?(deviceId: string, pinned: boolean): Promise<MobilePopOut[]>;
  /** Tells the window the device's shape, so resizing keeps it. */
  setPopOutAspect?(input: MobilePopOutAspectInput): Promise<void>;
};

export type NotificationSettings = { enabled: boolean; sound: boolean };

/** A window or screen that can be attached as a picture. The thumbnail is a data URL. */
export type CaptureSource = { id: string; name: string; kind: "window" | "screen"; thumbnail?: string };

declare global {
  interface Window {
    zli?: ZliBridge;
  }
}

export function getBridge(): ZliBridge | undefined {
  return typeof window === "undefined" ? undefined : window.zli;
}
