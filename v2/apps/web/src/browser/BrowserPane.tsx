import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { BrowserTabProjection, WorktreeProjection } from "@zli-v2/contracts";
import { useRuntime } from "../runtime/RuntimeProvider.js";

const DEFAULT_PROFILE_ID = "00000000-0000-4000-8000-000000000002";

type Props = {
  worktree: WorktreeProjection | undefined;
  /** True while app UI (dialogs, palette) must sit above the pane; the native view cannot be layered under DOM. */
  obscured?: boolean;
};

export function BrowserPane({ worktree, obscured = false }: Props) {
  const { bridge, projection } = useRuntime();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const urlEditedRef = useRef(false);
  const obscuredRef = useRef(obscured);
  const [tab, setTab] = useState<BrowserTabProjection>();
  const [url, setUrlState] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const worktreeId = worktree?.worktreeId;
  const showUrl = useCallback((value: string) => {
    urlEditedRef.current = false;
    setUrlState(value === "about:blank" ? "" : value);
  }, []);

  useEffect(() => {
    obscuredRef.current = obscured;
  }, [obscured]);
  const worktreeTabs = useMemo(
    () => projection?.browserTabs.filter((candidate) => candidate.worktreeId === worktreeId) ?? [],
    [projection?.browserTabs, worktreeId],
  );
  const restoredTab = worktreeTabs.find((candidate) => candidate.active) ?? worktreeTabs[0];

  const activateInSurface = useCallback(
    async (browserTabId: string) => {
      if (!bridge) throw new Error("The desktop bridge is unavailable.");
      if (surfaceRef.current) await bridge.browser.setBounds(browserTabId, measureBounds(surfaceRef.current));
      const active = await bridge.browser.activate(browserTabId);
      if (obscuredRef.current) await bridge.browser.hide();
      return active;
    },
    [bridge],
  );

  const previousWorktreeId = useRef(worktreeId);
  useEffect(() => {
    if (previousWorktreeId.current === worktreeId) return;
    previousWorktreeId.current = worktreeId;
    setTab(undefined);
    showUrl("");
    setError(undefined);
  }, [showUrl, worktreeId]);

  useEffect(() => {
    if (!bridge || !worktreeId || !restoredTab || tab) return;
    let disposed = false;
    setBusy(true);
    setError(undefined);
    void bridge.browser
      .create({
        browserTabId: restoredTab.browserTabId,
        worktreeId: restoredTab.worktreeId,
        profileId: restoredTab.profileId,
        url: restoredTab.url,
      })
      .then((next) => activateInSurface(next.browserTabId))
      .then((next) => {
        if (disposed) return;
        setTab(next);
        showUrl(next.url);
      })
      .catch((cause) => {
        if (!disposed)
          setError(cause instanceof Error ? cause.message : "The saved browser tab could not be restored.");
      })
      .finally(() => {
        if (!disposed) setBusy(false);
      });
    return () => {
      disposed = true;
    };
  }, [activateInSurface, bridge, restoredTab, showUrl, tab, worktreeId]);

  const visibleTabId = tab && !obscured ? tab.browserTabId : undefined;
  useEffect(() => {
    if (!bridge) return;
    const hide = () => void bridge.browser.hide().catch(() => undefined);
    const surface = surfaceRef.current;
    if (!visibleTabId || !surface) {
      hide();
      return;
    }
    let lastKey: string | undefined;
    // Layout shifts (notice bar, attention panel, sidebar collapse) move the surface without
    // resizing it, so ResizeObserver alone misses them; a per-frame check catches every move.
    const sync = () => {
      const bounds = measureBounds(surface);
      const key = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
      if (key === lastKey) return;
      lastKey = key;
      void bridge.browser.setBounds(visibleTabId, bounds).catch(() => undefined);
    };
    sync();
    void bridge.browser.activate(visibleTabId).catch(() => undefined);
    let frame: number | undefined;
    const tick = () => {
      sync();
      frame = window.requestAnimationFrame(tick);
    };
    if (typeof window.requestAnimationFrame === "function") frame = window.requestAnimationFrame(tick);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(sync) : undefined;
    observer?.observe(surface);
    window.addEventListener("resize", sync);
    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", sync);
      hide();
    };
  }, [bridge, visibleTabId]);

  const openUrl = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!bridge || !worktree || !url.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      const next = tab
        ? await bridge.browser.navigate(tab.browserTabId, normalizeUrl(url))
        : await bridge.browser
            .create({ worktreeId: worktree.worktreeId, profileId: DEFAULT_PROFILE_ID, url: normalizeUrl(url) })
            .then((created) => activateInSurface(created.browserTabId));
      setTab(next);
      showUrl(next.url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The browser could not open this URL.");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!tab) return;
    const next = projection?.browserTabs.find((candidate) => candidate.browserTabId === tab.browserTabId);
    if (!next) {
      setTab(undefined);
      showUrl("");
      return;
    }
    if (
      next.title === tab.title &&
      next.url === tab.url &&
      next.status === tab.status &&
      next.active === tab.active &&
      next.loadError === tab.loadError
    )
      return;
    const editing = urlEditedRef.current && document.activeElement === urlInputRef.current;
    if (next.url !== tab.url && !editing) showUrl(next.url);
    setTab(next);
  }, [projection?.browserTabs, showUrl, tab]);

  const run = async (
    operation: (activeBridge: NonNullable<typeof bridge>, activeTab: BrowserTabProjection) => Promise<unknown>,
  ) => {
    if (!tab) return;
    setError(undefined);
    try {
      if (!bridge) throw new Error("The desktop bridge is unavailable.");
      await operation(bridge, tab);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The browser operation failed.");
    }
  };

  const selectTab = async (candidate: BrowserTabProjection) => {
    if (!bridge) return;
    setBusy(true);
    setError(undefined);
    try {
      const restored = await bridge.browser.create({
        browserTabId: candidate.browserTabId,
        worktreeId: candidate.worktreeId,
        profileId: candidate.profileId,
        url: candidate.url,
      });
      const active = await activateInSurface(restored.browserTabId);
      setTab(active);
      showUrl(active.url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The browser tab could not be activated.");
    } finally {
      setBusy(false);
    }
  };

  const closeTab = async (candidate: BrowserTabProjection) => {
    if (!bridge) return;
    setBusy(true);
    setError(undefined);
    try {
      if (candidate.browserTabId !== tab?.browserTabId) await selectTab(candidate);
      await bridge.browser.close(candidate.browserTabId);
      if (candidate.browserTabId === tab?.browserTabId) {
        const next = worktreeTabs.find((tabCandidate) => tabCandidate.browserTabId !== candidate.browserTabId);
        if (next) await selectTab(next);
        else {
          setTab(undefined);
          showUrl("");
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The browser tab could not be closed.");
    } finally {
      setBusy(false);
    }
  };

  const newTab = async () => {
    if (!bridge || !worktree) return;
    setBusy(true);
    setError(undefined);
    try {
      const created = await bridge.browser.create({
        worktreeId: worktree.worktreeId,
        profileId: tab?.profileId ?? DEFAULT_PROFILE_ID,
        url: "about:blank",
      });
      const active = await activateInSurface(created.browserTabId);
      setTab(active);
      showUrl("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The new browser tab could not be opened.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tool-pane browser-pane">
      {worktree && (
        <div className="browser-tabs" role="tablist" aria-label="Worktree browser tabs">
          {worktreeTabs.map((candidate) => (
            <div
              className={`browser-tab${candidate.browserTabId === tab?.browserTabId ? " is-active" : ""}`}
              key={candidate.browserTabId}
            >
              <button
                type="button"
                role="tab"
                aria-selected={candidate.browserTabId === tab?.browserTabId}
                onClick={() => void selectTab(candidate)}
              >
                {candidate.title || candidate.url}
              </button>
              <button
                className="browser-tab-close"
                type="button"
                onClick={() => void closeTab(candidate)}
                aria-label={`Close ${candidate.title || candidate.url}`}
              >
                ×
              </button>
            </div>
          ))}
          <button
            className="browser-tab-new"
            type="button"
            onClick={() => void newTab()}
            disabled={busy}
            aria-label="New browser tab"
          >
            +
          </button>
        </div>
      )}
      <div className="tool-pane-header browser-header">
        <div>
          <span className="eyebrow">Browser</span>
          <h2>{tab?.title || "Chromium workspace"}</h2>
        </div>
        <nav className="browser-controls" aria-label="Browser controls">
          <button
            className="icon-button"
            type="button"
            disabled={!tab}
            onClick={() => void run((activeBridge, activeTab) => activeBridge.browser.back(activeTab.browserTabId))}
            aria-label="Back"
          >
            ←
          </button>
          <button
            className="icon-button"
            type="button"
            disabled={!tab}
            onClick={() => void run((activeBridge, activeTab) => activeBridge.browser.forward(activeTab.browserTabId))}
            aria-label="Forward"
          >
            →
          </button>
          <button
            className="icon-button"
            type="button"
            disabled={!tab}
            onClick={() => void run((activeBridge, activeTab) => activeBridge.browser.reload(activeTab.browserTabId))}
            aria-label="Reload"
          >
            ↻
          </button>
          <button
            className="icon-button"
            type="button"
            disabled={!tab}
            onClick={() =>
              void run((activeBridge, activeTab) => activeBridge.browser.openDevTools(activeTab.browserTabId))
            }
            aria-label="Open browser developer tools"
          >
            ⌘
          </button>
        </nav>
      </div>
      <form className="browser-address" onSubmit={(event) => void openUrl(event)}>
        <input
          ref={urlInputRef}
          aria-label="Browser URL"
          placeholder="Enter an http(s) URL"
          value={url}
          onChange={(event) => {
            urlEditedRef.current = true;
            setUrlState(event.target.value);
          }}
        />
        <button className="primary-button" type="submit" disabled={!worktree || !url.trim() || busy}>
          {busy ? "Opening" : tab ? "Go" : "Open"}
        </button>
      </form>
      {(error ?? tab?.loadError) && (
        <p className="inline-error" role="alert">
          {error ?? tab?.loadError}
        </p>
      )}
      <div className={`browser-surface${tab ? " has-tab" : ""}`} ref={surfaceRef}>
        {!tab && (
          <div className="empty-pane browser-empty">
            <p className="empty-title">A browser that belongs to this worktree</p>
            <p className="empty-detail">
              Open a local dev server or any trusted HTTP(S) page above. Its cookies stay isolated to this worktree and
              profile.
            </p>
          </div>
        )}
        {!worktree && (
          <div className="empty-pane browser-empty">
            <p className="empty-title">Select a worktree first</p>
            <p className="empty-detail">
              Browser tabs are restored per worktree, so the runtime needs a workspace before it can open Chromium.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function measureBounds(surface: HTMLElement) {
  const rect = surface.getBoundingClientRect();
  return {
    x: Math.max(0, Math.round(rect.left)),
    y: Math.max(0, Math.round(rect.top)),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  };
}

function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  return /^https?:\/\//iu.test(trimmed) ? trimmed : `http://${trimmed}`;
}
