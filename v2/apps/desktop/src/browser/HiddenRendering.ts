export type WakeableWebContents = {
  setBackgroundThrottling?(allowed: boolean): void;
  getOSProcessId?(): number;
  isDestroyed(): boolean;
};

export type CapturableWebContents = {
  capturePage?(
    rect?: undefined,
    options?: { stayHidden?: boolean; stayAwake?: boolean },
  ): Promise<{ toPNG(): Buffer; toJPEG(quality: number): Buffer; isEmpty(): boolean }>;
};

const WAKE_SETTLE_MS = 120;

/**
 * A WebContentsView that was never shown keeps a hidden render widget, and Chromium drops mouse
 * input sent to it. Electron's setBackgroundThrottling(false) marks such a widget shown and stops it
 * from being hidden again, so toggling it once per renderer process makes trusted input work while
 * the Browser panel is closed or the window is minimized.
 */
export function createInputWaker(
  contents: WakeableWebContents,
  options: { settleMs?: number; sleep?: (milliseconds: number) => Promise<void> } = {},
): () => Promise<void> {
  let wokenProcessId: number | undefined;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  return async () => {
    if (contents.isDestroyed() || !contents.setBackgroundThrottling) return;
    const processId = contents.getOSProcessId?.() ?? 0;
    if (wokenProcessId === processId) return;
    contents.setBackgroundThrottling(true);
    contents.setBackgroundThrottling(false);
    wokenProcessId = processId;
    // The shown state reaches the renderer asynchronously; input sent before it lands is dropped.
    await sleep(options.settleMs ?? WAKE_SETTLE_MS);
  };
}

/** CDP capture stalls while the window is minimized; capturePage still works there. */
export function createCaptureFallback(
  contents: CapturableWebContents,
): ((format: "png" | "jpeg") => Promise<string | undefined>) | undefined {
  if (!contents.capturePage) return undefined;
  return async (format) => {
    const image = await contents.capturePage?.(undefined, { stayHidden: true, stayAwake: true });
    if (!image || image.isEmpty()) return undefined;
    return (format === "jpeg" ? image.toJPEG(85) : image.toPNG()).toString("base64");
  };
}
