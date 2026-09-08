import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Webview } from "@tauri-apps/api/webview";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { IconBack, IconExternal, IconForward, IconGlobe, IconReload } from "./AppIcons";
import { rafThrottle } from "../lib/schedule";
import { isTauriRuntime } from "../tauri/invoke";
import { useUiStore } from "../stores/uiStore";
import { normalizeBrowserInput, pushBrowserHistory } from "../lib/browserNavigation";

const STARTER_LINKS = [
  { label: "GitHub", url: "https://github.com" },
  { label: "MDN", url: "https://developer.mozilla.org" },
  { label: "npm", url: "https://www.npmjs.com" },
];

let webviewSequence = 0;

interface BrowserPanelProps {
  obscured?: boolean;
}

interface BrowserNavigationEvent {
  label: string;
  url: string;
  phase: "started" | "finished";
}

export function BrowserPanel({ obscured = false }: BrowserPanelProps) {
  const savedUrl = useUiStore((state) => state.browserUrl);
  const [history, setHistory] = useState<string[]>(() => savedUrl ? [savedUrl] : []);
  const [historyIndex, setHistoryIndex] = useState(savedUrl ? 0 : -1);
  const [draft, setDraft] = useState(savedUrl);
  const [frameVersion, setFrameVersion] = useState(0);
  const [nativeError, setNativeError] = useState<string | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const nativeWebviewRef = useRef<Webview | null>(null);
  const nativeLabelRef = useRef<string | null>(null);
  const expectedNavigationRef = useRef<string | null>(savedUrl || null);
  const historyRef = useRef(history);
  const historyIndexRef = useRef(historyIndex);
  const nativeBrowser = isTauriRuntime();
  const dialogOpen = useUiStore((state) =>
    state.addAgentOpen || state.pathDialogOpen || state.commitOpen || state.discardOpen ||
    state.mergeOpen || state.helpOpen || state.preferencesOpen,
  );
  const shouldHideNativeView = obscured || dialogOpen;
  const shouldHideNativeViewRef = useRef(shouldHideNativeView);
  shouldHideNativeViewRef.current = shouldHideNativeView;
  const currentUrl = history[historyIndex] ?? "";
  historyRef.current = history;
  historyIndexRef.current = historyIndex;
  useEffect(() => { useUiStore.getState().setBrowserUrl(currentUrl); }, [currentUrl]);

  useEffect(() => {
    if (!nativeBrowser) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<BrowserNavigationEvent>("browser-navigation", ({ payload }) => {
      if (disposed || payload.label !== nativeLabelRef.current) return;
      const observed = normalizeBrowserInput(payload.url);
      if (!observed) return;
      const currentHistory = historyRef.current;
      const currentIndex = historyIndexRef.current;
      if (currentIndex < 0) return;
      const current = currentHistory[currentIndex];
      let nextHistory = currentHistory;
      let nextIndex = currentIndex;

      if (observed !== current) {
        if (expectedNavigationRef.current) {
          nextHistory = currentHistory.map((entry, index) => index === currentIndex ? observed : entry);
        } else {
          const next = pushBrowserHistory(currentHistory, currentIndex, observed);
          nextHistory = next.history;
          nextIndex = next.index;
          expectedNavigationRef.current = observed;
        }
        historyRef.current = nextHistory;
        historyIndexRef.current = nextIndex;
        setHistory(nextHistory);
        setHistoryIndex(nextIndex);
      }
      setDraft(observed);
      if (payload.phase === "finished") expectedNavigationRef.current = null;
    }).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [nativeBrowser]);

  useEffect(() => {
    if (!nativeBrowser || !currentUrl) return;
    let cancelled = false;
    let observer: ResizeObserver | null = null;
    let removeWindowResizeListener: (() => void) | null = null;

    async function updateBounds(webview: Webview) {
      const viewport = viewportRef.current;
      if (!viewport || cancelled) return;
      const rect = viewport.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      await webview.setPosition(new LogicalPosition(rect.left, rect.top));
      await webview.setSize(new LogicalSize(rect.width, rect.height));
    }

    const throttledBounds = rafThrottle(() => {
      const webview = nativeWebviewRef.current;
      if (webview) void updateBounds(webview);
    });

    async function mountWebview() {
      setNativeError(null);
      const viewport = viewportRef.current;
      if (!viewport) return;
      const rect = viewport.getBoundingClientRect();
      const label = `browser-panel-${++webviewSequence}`;
      nativeLabelRef.current = label;
      expectedNavigationRef.current = currentUrl;
      const webview = new Webview(getCurrentWindow(), label, {
        url: currentUrl,
        x: rect.left,
        y: rect.top,
        width: Math.max(1, rect.width),
        height: Math.max(1, rect.height),
        focus: false,
        dragDropEnabled: false,
        backgroundColor: [11, 14, 20, 255],
      });
      await new Promise<void>((resolve, reject) => {
        void webview.once("tauri://created", () => resolve()).catch(reject);
        void webview.once("tauri://error", (event) => {
          reject(new Error(`The embedded browser could not be created: ${String(event.payload)}`));
        }).catch(reject);
      });
      if (cancelled) {
        await webview.close().catch(() => undefined);
        return;
      }

      nativeWebviewRef.current = webview;
      const handleWindowResize = () => throttledBounds();
      await webview.setAutoResize(false);
      if (shouldHideNativeViewRef.current) await webview.hide();
      else await webview.show();
      await updateBounds(webview);
      observer = new ResizeObserver(() => throttledBounds());
      observer.observe(viewport);
      window.addEventListener("resize", handleWindowResize);
      removeWindowResizeListener = () => window.removeEventListener("resize", handleWindowResize);

      if (cancelled) {
        observer.disconnect();
        removeWindowResizeListener();
        removeWindowResizeListener = null;
        await webview.close().catch(() => undefined);
        return;
      }
    }

    void mountWebview().catch((error) => {
      if (!cancelled) setNativeError(error instanceof Error ? error.message : String(error));
    });

    return () => {
      cancelled = true;
      throttledBounds.cancel();
      observer?.disconnect();
      removeWindowResizeListener?.();
      removeWindowResizeListener = null;
      const webview = nativeWebviewRef.current;
      nativeWebviewRef.current = null;
      if (nativeLabelRef.current === webview?.label) nativeLabelRef.current = null;
      void webview?.close().catch(() => undefined);
    };
  }, [currentUrl, frameVersion, nativeBrowser]);

  useEffect(() => {
    const webview = nativeWebviewRef.current;
    if (!webview) return;
    void (shouldHideNativeView ? webview.hide() : webview.show()).catch((error) => {
      setNativeError(error instanceof Error ? error.message : String(error));
    });
  }, [shouldHideNativeView]);

  function navigate(value: string) {
    const normalized = normalizeBrowserInput(value);
    if (!normalized) {
      setNativeError("Enter a valid http or https address.");
      return;
    }
    const next = pushBrowserHistory(history, historyIndex, normalized);
    expectedNavigationRef.current = normalized;
    setHistory(next.history);
    setHistoryIndex(next.index);
    setNativeError(null);
    setDraft(normalized);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    navigate(draft);
  }

  function onUrlKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      setDraft(currentUrl);
      event.currentTarget.blur();
    }
  }

  function goBack() {
    if (historyIndex <= 0) return;
    const next = historyIndex - 1;
    expectedNavigationRef.current = history[next];
    setHistoryIndex(next);
    setDraft(history[next]);
  }

  function goForward() {
    if (historyIndex >= history.length - 1) return;
    const next = historyIndex + 1;
    expectedNavigationRef.current = history[next];
    setHistoryIndex(next);
    setDraft(history[next]);
  }

  function reload() {
    if (!currentUrl) return;
    expectedNavigationRef.current = currentUrl;
    setFrameVersion((current) => current + 1);
  }

  async function openExternally() {
    if (!currentUrl) return;
    try {
      await openUrl(currentUrl);
    } catch {
      window.open(currentUrl, "_blank", "noopener,noreferrer");
    }
  }

  return (
    <section className="flex h-full min-h-0 flex-col bg-ink">
      <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-line bg-chrome px-2">
        <button
          type="button"
          aria-label="Back"
          title="Back"
          className="btn btn-icon"
          onClick={goBack}
          disabled={historyIndex <= 0}
        >
          <IconBack />
        </button>
        <button
          type="button"
          aria-label="Forward"
          title="Forward"
          className="btn btn-icon"
          onClick={goForward}
          disabled={historyIndex >= history.length - 1}
        >
          <IconForward />
        </button>
        <button
          type="button"
          aria-label="Reload"
          title="Reload"
          className="btn btn-icon"
          onClick={reload}
          disabled={!currentUrl}
        >
          <IconReload />
        </button>
        <form className="flex min-w-0 flex-1" onSubmit={submit}>
          <label className="flex min-w-0 flex-1 items-center rounded-lg border border-line bg-ink px-2.5 focus-within:border-accent">
            <span className="mr-2 text-mute">
              <IconGlobe className="h-3.5 w-3.5" />
            </span>
            <input
              aria-label="Web address"
              className="min-w-0 flex-1 bg-transparent py-1.5 text-[12px] text-paper outline-none placeholder:text-mute"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onUrlKeyDown}
              placeholder="Enter a web address"
              spellCheck={false}
            />
          </label>
          <button type="submit" className="btn btn-primary ml-1.5 h-8">
            Go
          </button>
        </form>
        <button
          type="button"
          className="btn btn-icon"
          title="Open externally"
          aria-label="Open externally"
          onClick={() => void openExternally()}
          disabled={!currentUrl}
        >
          <IconExternal />
        </button>
      </div>

      <div className="min-h-0 flex-1 bg-ink">
        {currentUrl ? (
          <div ref={viewportRef} className="relative h-full w-full bg-panel">
            {!nativeBrowser ? (
              <iframe
                key={`${currentUrl}:${frameVersion}`}
                title="Taxzy browser"
                src={currentUrl}
                className="h-full w-full border-0 bg-white"
                referrerPolicy="strict-origin-when-cross-origin"
              />
            ) : nativeError ? (
              <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
                <p role="alert" className="text-[13px] font-medium text-paper">This page could not open inside Taxzy</p>
                <p className="max-w-sm break-words text-[12px] text-mute">{nativeError}</p>
                <div className="flex flex-wrap justify-center gap-2">
                  <button type="button" className="btn btn-primary" onClick={reload}>Retry</button>
                  <button type="button" className="btn btn-quiet" onClick={() => void openExternally()}>Open externally</button>
                </div>
              </div>
            ) : (
              <div className="flex h-full items-center justify-center text-[12px] text-mute">Loading page…</div>
            )}
          </div>
        ) : (
          <div className="empty-panel px-6">
            <div className="w-full max-w-xl rounded-xl border border-line bg-panel p-6">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-raised text-accent">
                  <IconGlobe className="h-5 w-5" />
                </div>
                <div>
                  <div className="text-[16px] font-semibold text-paper">Browse beside your agents</div>
                  <p className="mt-1 text-[12px] leading-5 text-mute">
                    Look up docs, inspect a GitHub issue, or keep a reference page open while the workspace runs.
                  </p>
                </div>
              </div>
              <div className="mt-5 flex flex-wrap gap-2">
                {STARTER_LINKS.map((link) => (
                  <button
                    key={link.url}
                    type="button"
                    className="btn btn-quiet h-8"
                    onClick={() => navigate(link.url)}
                  >
                    {link.label}
                  </button>
                ))}
              </div>
              <div className="mt-5 border-t border-line pt-3 text-[11px] leading-5 text-mute">
                Some sites prevent embedded views. If a page is blank, use Open externally in the toolbar.
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
