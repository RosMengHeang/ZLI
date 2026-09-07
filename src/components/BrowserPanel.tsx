import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Webview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { IconBack, IconExternal, IconForward, IconGlobe, IconReload } from "./AppIcons";
import { rafThrottle } from "../lib/schedule";
import { isTauriRuntime } from "../tauri/invoke";

const STARTER_LINKS = [
  { label: "GitHub", url: "https://github.com" },
  { label: "MDN", url: "https://developer.mozilla.org" },
  { label: "npm", url: "https://www.npmjs.com" },
];

function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export function BrowserPanel() {
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [draft, setDraft] = useState("");
  const [frameVersion, setFrameVersion] = useState(0);
  const [nativeError, setNativeError] = useState<string | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const nativeWebviewRef = useRef<Webview | null>(null);
  const nativeBrowser = isTauriRuntime();
  const currentUrl = history[historyIndex] ?? "";

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
      const previous = await Webview.getByLabel("browser-panel");
      await previous?.close().catch(() => undefined);
      if (cancelled) return;

      const viewport = viewportRef.current;
      if (!viewport) return;
      const rect = viewport.getBoundingClientRect();
      const webview = new Webview(getCurrentWindow(), "browser-panel", {
        url: currentUrl,
        x: rect.left,
        y: rect.top,
        width: Math.max(1, rect.width),
        height: Math.max(1, rect.height),
        focus: false,
        dragDropEnabled: false,
      });
      nativeWebviewRef.current = webview;
      const handleWindowResize = () => throttledBounds();
      await webview.once("tauri://error", () => {
        if (!cancelled) setNativeError("The page could not be loaded in the embedded browser.");
      });
      await webview.setAutoResize(false);
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
      void webview?.close().catch(() => undefined);
    };
  }, [currentUrl, frameVersion, nativeBrowser]);

  function navigate(value: string) {
    const normalized = normalizeUrl(value);
    if (normalized === "https://") return;
    setHistory((current) => [...current.slice(0, historyIndex + 1), normalized]);
    setHistoryIndex((current) => current + 1);
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
    setHistoryIndex(next);
    setDraft(history[next]);
  }

  function goForward() {
    if (historyIndex >= history.length - 1) return;
    const next = historyIndex + 1;
    setHistoryIndex(next);
    setDraft(history[next]);
  }

  function reload() {
    if (!currentUrl) return;
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
              placeholder="Search or enter a web address"
              spellCheck={false}
            />
          </label>
          <button type="submit" className="btn btn-primary ml-1.5 h-8">
            Go
          </button>
        </form>
        <button
          type="button"
          className="btn btn-ghost hidden sm:inline-flex"
          onClick={() => void openExternally()}
          disabled={!currentUrl}
        >
          <IconExternal />
          Open externally
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
              <div className="flex h-full items-center justify-center px-6 text-center text-[12px] text-warn">
                {nativeError}
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
