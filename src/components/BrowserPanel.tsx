import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Webview } from "@tauri-apps/api/webview";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { IconBack, IconExternal, IconForward, IconGlobe, IconReload, IconShield } from "./AppIcons";
import { rafThrottle } from "../lib/schedule";
import { isTauriRuntime } from "../tauri/invoke";
import { useUiStore } from "../stores/uiStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import {
  closeBrowserSurface,
  grantBrowserCapability,
  registerBrowserSurface,
  updateBrowserNavigation,
} from "../lib/browser/browserBridge";
import { useBrowserStore } from "../stores/browserStore";
import { BrowserPermissionDialog } from "./BrowserPermissionDialog";
import { nextBrowserRequest, normalizeBrowserInput, pushBrowserHistory } from "../lib/browserNavigation";
import {
  nativeBrowserBounds,
  nativeBrowserHiddenBounds,
  nativeBrowserRectIsUsable,
} from "../lib/chromePresentation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

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

async function collapseNativeWebview(webview: Webview, isCancelled?: () => boolean): Promise<void> {
  const bounds = nativeBrowserHiddenBounds();
  await webview.hide();
  if (isCancelled?.()) return;
  await webview.setPosition(new LogicalPosition(bounds.x, bounds.y));
  if (isCancelled?.()) return;
  await webview.setSize(new LogicalSize(bounds.width, bounds.height));
}

export function BrowserPanel({ obscured = false }: BrowserPanelProps) {
  const activeProjectRoot = useWorkspaceStore((state) => state.activeProjectRoot);
  const savedUrl = useUiStore((state) => state.browserUrl);
  const permissionOpen = useBrowserStore((state) => state.permissionOpen);
  const browserSurface = useBrowserStore((state) => state.surface);
  const setPermissionOpen = useBrowserStore((state) => state.setPermissionOpen);
  const [history, setHistory] = useState<string[]>(() => savedUrl ? [savedUrl] : []);
  const [historyIndex, setHistoryIndex] = useState(savedUrl ? 0 : -1);
  const [request, setRequest] = useState({ url: savedUrl, sequence: 0 });
  const [draft, setDraft] = useState(savedUrl);
  const [nativeError, setNativeError] = useState<string | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const nativeWebviewRef = useRef<Webview | null>(null);
  const nativeLabelRef = useRef<string | null>(null);
  const browserSurfaceIdRef = useRef<string | null>(null);
  const expectedNavigationRef = useRef<string | null>(savedUrl || null);
  const historyRef = useRef(history);
  const historyIndexRef = useRef(historyIndex);
  const nativeBrowser = isTauriRuntime();
  const dialogOpen = useUiStore((state) =>
    state.addAgentOpen || state.pathDialogOpen || state.commitOpen || state.discardOpen ||
    state.mergeOpen || state.helpOpen || state.preferencesOpen,
  );
  const shouldHideNativeView = obscured || dialogOpen || permissionOpen;
  const shouldHideNativeViewRef = useRef(shouldHideNativeView);
  const currentUrl = history[historyIndex] ?? "";
  useEffect(() => {
    shouldHideNativeViewRef.current = shouldHideNativeView;
    historyRef.current = history;
    historyIndexRef.current = historyIndex;
  }, [history, historyIndex, shouldHideNativeView]);
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
      if (observed !== current) {
        let nextHistory: string[];
        let nextIndex: number;
        if (expectedNavigationRef.current) {
          nextHistory = currentHistory.map((entry, index) => index === currentIndex ? observed : entry);
          nextIndex = currentIndex;
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
      const surfaceId = browserSurfaceIdRef.current;
      if (surfaceId) void updateBrowserNavigation(surfaceId, observed)
        .then((surface) => useBrowserStore.getState().setSurface(surface))
        .catch(() => undefined);
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
    if (!nativeBrowser || !request.url || !activeProjectRoot) return;
    const projectRoot = activeProjectRoot;
    let cancelled = false;
    let observer: ResizeObserver | null = null;
    let removeWindowResizeListener: (() => void) | null = null;

    async function updateBounds(webview: Webview): Promise<boolean> {
      const viewport = viewportRef.current;
      if (!viewport || cancelled) return false;
      const rect = viewport.getBoundingClientRect();
      if (!nativeBrowserRectIsUsable(rect, { width: window.innerWidth, height: window.innerHeight })) {
        await collapseNativeWebview(webview, () => cancelled);
        return false;
      }
      const bounds = nativeBrowserBounds(rect);
      await webview.setPosition(new LogicalPosition(bounds.x, bounds.y));
      if (cancelled) return false;
      await webview.setSize(new LogicalSize(bounds.width, bounds.height));
      return !cancelled;
    }

    const throttledBounds = rafThrottle(() => {
      const webview = nativeWebviewRef.current;
      if (webview) {
        void updateBounds(webview).then((usable) => {
          if (usable && !cancelled && !shouldHideNativeViewRef.current) {
            void webview.show().catch(() => undefined);
          }
        }).catch(() => undefined);
      }
    });

    async function mountWebview() {
      setNativeError(null);
      const viewport = viewportRef.current;
      if (!viewport) return;
      const label = `browser-panel-${++webviewSequence}`;
      nativeLabelRef.current = label;
      expectedNavigationRef.current = request.url;
      const bounds = nativeBrowserHiddenBounds();
      const webview = new Webview(getCurrentWindow(), label, {
        url: request.url,
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
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
        await webview.hide().catch(() => undefined);
        await webview.close().catch(() => undefined);
        return;
      }

      nativeWebviewRef.current = webview;
      let surface = await registerBrowserSurface({
        projectId: projectRoot,
        agentId: null,
        webviewLabel: label,
        url: request.url,
        profileId: "default",
      });
      const savedCapabilities = useBrowserStore.getState().savedCapabilities(projectRoot, "default");
      for (const capability of savedCapabilities) {
        surface = await grantBrowserCapability(surface.surfaceId, capability);
      }
      if (cancelled) {
        await closeBrowserSurface(surface.surfaceId).catch(() => undefined);
        await webview.close().catch(() => undefined);
        return;
      }
      browserSurfaceIdRef.current = surface.surfaceId;
      useBrowserStore.getState().setSurface(surface);
      const handleWindowResize = () => throttledBounds();
      await webview.setAutoResize(false);
      // A newly-created native child can briefly cover the entire Tauri view.
      // Keep it hidden until its final sibling-panel bounds have been applied.
      await webview.hide();
      if (cancelled) {
        await webview.close().catch(() => undefined);
        return;
      }
      const usable = await updateBounds(webview);
      if (usable && !shouldHideNativeViewRef.current) await webview.show();
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
      const surfaceId = browserSurfaceIdRef.current;
      browserSurfaceIdRef.current = null;
      if (useBrowserStore.getState().surface?.surfaceId === surfaceId) {
        useBrowserStore.getState().setSurface(null);
      }
      nativeWebviewRef.current = null;
      if (nativeLabelRef.current === webview?.label) nativeLabelRef.current = null;
      if (webview) {
        const webviewToClose = webview;
        void collapseNativeWebview(webviewToClose)
          .then(() => webviewToClose.close())
          .catch(() => undefined);
      }
      if (surfaceId) void closeBrowserSurface(surfaceId).catch(() => undefined);
    };
  }, [request, nativeBrowser, activeProjectRoot]);

  useEffect(() => {
    const webview = nativeWebviewRef.current;
    if (!webview) return;
    const activeWebview = webview;
    let cancelled = false;

    async function syncVisibility() {
      if (shouldHideNativeView) {
        await collapseNativeWebview(activeWebview, () => cancelled);
        return;
      }

      const viewport = viewportRef.current;
      if (!viewport) return;
      const rect = viewport.getBoundingClientRect();
      if (!nativeBrowserRectIsUsable(rect, { width: window.innerWidth, height: window.innerHeight })) {
        await collapseNativeWebview(activeWebview, () => cancelled);
        return;
      }
      const bounds = nativeBrowserBounds(rect);
      await activeWebview.setPosition(new LogicalPosition(bounds.x, bounds.y));
      if (cancelled) return;
      await activeWebview.setSize(new LogicalSize(bounds.width, bounds.height));
      if (!cancelled) await activeWebview.show();
    }

    void syncVisibility().catch((error) => {
      if (!cancelled) setNativeError(error instanceof Error ? error.message : String(error));
    });
    return () => {
      cancelled = true;
    };
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
    setRequest((current) => nextBrowserRequest(normalized, current.sequence));
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
    setRequest((current) => nextBrowserRequest(history[next], current.sequence));
  }

  function goForward() {
    if (historyIndex >= history.length - 1) return;
    const next = historyIndex + 1;
    expectedNavigationRef.current = history[next];
    setHistoryIndex(next);
    setDraft(history[next]);
    setRequest((current) => nextBrowserRequest(history[next], current.sequence));
  }

  function reload() {
    if (!currentUrl) return;
    expectedNavigationRef.current = currentUrl;
    setRequest((current) => nextBrowserRequest(currentUrl, current.sequence));
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
    <section className="browser-shell flex h-full min-h-0 flex-col bg-ink">
      <div className="browser-toolbar flex h-11 shrink-0 items-center gap-1.5 border-b border-line bg-chrome px-2">
        <Tooltip><TooltipTrigger asChild><Button
          type="button"
          aria-label="Back"
          variant="ghost"
          size="icon-sm"
          onClick={goBack}
          disabled={historyIndex <= 0}
        >
          <IconBack />
        </Button></TooltipTrigger><TooltipContent>Back</TooltipContent></Tooltip>
        <Tooltip><TooltipTrigger asChild><Button
          type="button"
          aria-label="Forward"
          variant="ghost"
          size="icon-sm"
          onClick={goForward}
          disabled={historyIndex >= history.length - 1}
        >
          <IconForward />
        </Button></TooltipTrigger><TooltipContent>Forward</TooltipContent></Tooltip>
        <Tooltip><TooltipTrigger asChild><Button
          type="button"
          aria-label="Reload"
          variant="ghost"
          size="icon-sm"
          onClick={reload}
          disabled={!currentUrl}
        >
          <IconReload />
        </Button></TooltipTrigger><TooltipContent>Reload</TooltipContent></Tooltip>
        <form className="flex min-w-0 flex-1" onSubmit={submit}>
          <label className="flex min-w-0 flex-1 items-center rounded-lg border border-line bg-ink px-2.5 focus-within:border-accent">
            <span className="mr-2 text-mute">
              <IconGlobe className="h-3.5 w-3.5" />
            </span>
            <Input
              aria-label="Web address"
              className="h-7 min-w-0 flex-1 border-0 bg-transparent px-0 text-[12px] shadow-none focus-visible:ring-0"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onUrlKeyDown}
              placeholder="Enter a web address"
              spellCheck={false}
            />
          </label>
          <Button type="submit" size="sm" className="ml-1.5 h-8">
            Go
          </Button>
        </form>
        <Tooltip><TooltipTrigger asChild><Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Open externally"
          onClick={() => void openExternally()}
          disabled={!currentUrl}
        >
          <IconExternal />
        </Button></TooltipTrigger><TooltipContent>Open externally</TooltipContent></Tooltip>
        <Tooltip><TooltipTrigger asChild><Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Browser permissions"
          onClick={() => setPermissionOpen(true)}
          disabled={!browserSurface}
        >
          <IconShield />
        </Button></TooltipTrigger><TooltipContent>Agent browser access</TooltipContent></Tooltip>
      </div>

      <div className="browser-viewport-shell min-h-0 flex-1 bg-ink">
        {currentUrl ? (
          <div ref={viewportRef} className="browser-viewport relative h-full w-full bg-panel">
            {!nativeBrowser ? (
              <iframe
                key={`${currentUrl}:${request.sequence}`}
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
                  <Button type="button" onClick={reload}>Retry</Button>
                  <Button type="button" variant="secondary" onClick={() => void openExternally()}>Open externally</Button>
                </div>
              </div>
            ) : (
              <div className="flex h-full items-center justify-center text-[12px] text-mute">Loading page…</div>
            )}
          </div>
        ) : (
          <div className="browser-empty-state empty-panel px-6">
            <div className="browser-empty-card w-full max-w-sm p-5 text-center">
              <IconGlobe className="mx-auto h-5 w-5 text-mute" />
              <div className="mt-3 text-[14px] font-semibold text-paper">Open a page</div>
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                {STARTER_LINKS.map((link) => (
                  <Button
                    key={link.url}
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => navigate(link.url)}
                  >
                    {link.label}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
      <BrowserPermissionDialog />
    </section>
  );
}
