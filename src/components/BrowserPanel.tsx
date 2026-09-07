import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Webview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
      const handleWindowResize = () => void updateBounds(webview);
      await webview.once("tauri://error", () => {
        if (!cancelled) setNativeError("The page could not be loaded in the embedded browser.");
      });
      await webview.setAutoResize(false);
      observer = new ResizeObserver(() => void updateBounds(webview));
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
    <section className="flex h-full min-h-0 flex-col bg-[#1b1c1e]">
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-[#34363a] bg-[#242629] px-2">
        <button
          type="button"
          aria-label="Back"
          title="Back"
          className="h-6 w-6 text-[15px] text-[#a9abad] hover:bg-[#3b3e42] hover:text-white disabled:opacity-30"
          onClick={goBack}
          disabled={historyIndex <= 0}
        >
          ‹
        </button>
        <button
          type="button"
          aria-label="Forward"
          title="Forward"
          className="h-6 w-6 text-[15px] text-[#a9abad] hover:bg-[#3b3e42] hover:text-white disabled:opacity-30"
          onClick={goForward}
          disabled={historyIndex >= history.length - 1}
        >
          ›
        </button>
        <button
          type="button"
          aria-label="Reload"
          title="Reload"
          className="h-6 w-6 text-[13px] text-[#a9abad] hover:bg-[#3b3e42] hover:text-white disabled:opacity-30"
          onClick={reload}
          disabled={!currentUrl}
        >
          ↻
        </button>
        <form className="flex min-w-0 flex-1" onSubmit={submit}>
          <label className="flex min-w-0 flex-1 items-center border border-[#45484d] bg-[#1c1e20] px-2 focus-within:border-[#4ec9b0]">
            <span className="mr-2 text-[10px] text-[#6f7479]">⌕</span>
            <input
              aria-label="Web address"
              className="min-w-0 flex-1 bg-transparent py-1 text-[11px] text-[#d4d4d4] outline-none placeholder:text-[#6f7479]"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onUrlKeyDown}
              placeholder="Search or enter a web address"
              spellCheck={false}
            />
          </label>
          <button type="submit" className="ml-1 h-6 bg-[#0e639c] px-2 text-[10px] text-white hover:bg-[#1177bb]">
            Go
          </button>
        </form>
        <button
          type="button"
          className="hidden h-6 px-2 text-[10px] text-[#9b9da1] hover:bg-[#3b3e42] hover:text-white sm:block"
          onClick={() => void openExternally()}
          disabled={!currentUrl}
        >
          Open externally
        </button>
      </div>

      <div className="min-h-0 flex-1 bg-[#151719]">
        {currentUrl ? (
          <div ref={viewportRef} className="relative h-full w-full bg-[#202326]">
            {!nativeBrowser ? (
              <iframe
                key={`${currentUrl}:${frameVersion}`}
                title="Taxzy browser"
                src={currentUrl}
                className="h-full w-full border-0 bg-white"
                referrerPolicy="strict-origin-when-cross-origin"
              />
            ) : nativeError ? (
              <div className="flex h-full items-center justify-center px-6 text-center text-[11px] text-[#f4b183]">
                {nativeError}
              </div>
            ) : (
              <div className="flex h-full items-center justify-center text-[11px] text-[#7f858b]">Loading page…</div>
            )}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center px-6">
            <div className="w-full max-w-xl border border-[#34383d] bg-[#202326] p-6">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center bg-[#284653] text-lg text-[#4ec9b0]">⌁</div>
                <div>
                  <div className="text-[14px] font-semibold text-white">Browse beside your agents</div>
                  <p className="mt-1 text-[11px] leading-5 text-[#92979d]">
                    Look up docs, inspect a GitHub issue, or keep a reference page open while the workspace runs.
                  </p>
                </div>
              </div>
              <div className="mt-5 flex flex-wrap gap-2">
                {STARTER_LINKS.map((link) => (
                  <button
                    key={link.url}
                    type="button"
                    className="border border-[#45484d] bg-[#272a2d] px-3 py-1.5 text-[10px] text-[#c6c9cc] hover:border-[#4ec9b0] hover:text-white"
                    onClick={() => navigate(link.url)}
                  >
                    {link.label}
                  </button>
                ))}
              </div>
              <div className="mt-5 border-t border-[#34383d] pt-3 text-[10px] leading-5 text-[#6f7479]">
                Some sites prevent embedded views. If a page is blank, use “Open externally” in the browser toolbar.
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
