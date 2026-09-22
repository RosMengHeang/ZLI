import { useEffect, useMemo, useRef, useState } from "react";

import type { BrowserTabProjection, WorktreeProjection } from "@zli-v2/contracts";
import { useRuntime } from "../runtime/RuntimeProvider.js";

const DEFAULT_PROFILE_ID = "00000000-0000-4000-8000-000000000002";

export function BrowserPane({ worktree }: { worktree: WorktreeProjection | undefined }) {
  const { bridge, projection } = useRuntime();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<BrowserTabProjection>();
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const worktreeTabs = useMemo(() => projection?.browserTabs.filter((candidate) => candidate.worktreeId === worktree?.worktreeId) ?? [], [projection?.browserTabs, worktree?.worktreeId]);
  const restoredTab = worktreeTabs.find((candidate) => candidate.active) ?? worktreeTabs[0];

  useEffect(() => {
    setTab(undefined);
    setUrl("");
    setError(undefined);
  }, [worktree?.worktreeId]);

  useEffect(() => {
    if (!bridge || !worktree || !restoredTab || tab) return;
    let disposed = false;
    setBusy(true);
    setError(undefined);
    void bridge.browser.create({
      browserTabId: restoredTab.browserTabId,
      worktreeId: restoredTab.worktreeId,
      profileId: restoredTab.profileId,
      url: restoredTab.url,
    }).then((next) => bridge.browser.activate(next.browserTabId)).then((next) => {
      if (disposed) return;
      setTab(next);
      setUrl(next.url);
    }).catch((cause) => {
      if (!disposed) setError(cause instanceof Error ? cause.message : "The saved browser tab could not be restored.");
    }).finally(() => {
      if (!disposed) setBusy(false);
    });
    return () => { disposed = true; };
  }, [bridge, restoredTab, tab, worktree]);

  useEffect(() => {
    if (!tab || !surfaceRef.current || !bridge) return;
    const surface = surfaceRef.current;
    const syncBounds = () => {
      const rect = surface.getBoundingClientRect();
      void bridge.browser.setBounds(tab.browserTabId, {
        x: Math.max(0, Math.round(rect.left)),
        y: Math.max(0, Math.round(rect.top)),
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(rect.height)),
      }).catch(() => undefined);
    };
    const observer = new ResizeObserver(syncBounds);
    observer.observe(surface);
    syncBounds();
    return () => observer.disconnect();
  }, [bridge, tab]);

  const openUrl = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!bridge || !worktree || !url.trim()) return;
    setBusy(true); setError(undefined);
    try {
      const next = tab
        ? await bridge.browser.navigate(tab.browserTabId, normalizeUrl(url))
        : await bridge.browser.create({ worktreeId: worktree.worktreeId, profileId: DEFAULT_PROFILE_ID, url: normalizeUrl(url) }).then((created) => bridge.browser.activate(created.browserTabId));
      setTab(next); setUrl(next.url);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The browser could not open this URL."); }
    finally { setBusy(false); }
  };

  useEffect(() => {
    if (!tab) return;
    const next = projection?.browserTabs.find((candidate) => candidate.browserTabId === tab.browserTabId);
    if (!next) { setTab(undefined); setUrl(""); return; }
    if (next.title === tab.title && next.url === tab.url && next.status === tab.status && next.active === tab.active) return;
    setTab(next);
  }, [projection?.browserTabs, tab]);

  const run = async (operation: () => Promise<unknown>) => {
    if (!tab) return;
    setError(undefined);
    try { await operation(); } catch (cause) { setError(cause instanceof Error ? cause.message : "The browser operation failed."); }
  };

  const selectTab = async (candidate: BrowserTabProjection) => {
    if (!bridge) return;
    setBusy(true); setError(undefined);
    try {
      const restored = await bridge.browser.create({ browserTabId: candidate.browserTabId, worktreeId: candidate.worktreeId, profileId: candidate.profileId, url: candidate.url });
      const active = await bridge.browser.activate(restored.browserTabId);
      setTab(active); setUrl(active.url);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The browser tab could not be activated."); }
    finally { setBusy(false); }
  };

  const closeTab = async (candidate: BrowserTabProjection) => {
    if (!bridge) return;
    setBusy(true); setError(undefined);
    try {
      await bridge.browser.close(candidate.browserTabId);
      if (candidate.browserTabId === tab?.browserTabId) {
        const next = worktreeTabs.find((tabCandidate) => tabCandidate.browserTabId !== candidate.browserTabId);
        if (next) await selectTab(next); else { setTab(undefined); setUrl(""); }
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The browser tab could not be closed."); }
    finally { setBusy(false); }
  };

  return (
    <div className="tool-pane browser-pane">
      {worktreeTabs.length > 0 && <div className="browser-tabs" role="tablist" aria-label="Worktree browser tabs">{worktreeTabs.map((candidate) => <div className={`browser-tab${candidate.browserTabId === tab?.browserTabId ? " is-active" : ""}`} key={candidate.browserTabId}><button type="button" role="tab" aria-selected={candidate.browserTabId === tab?.browserTabId} onClick={() => void selectTab(candidate)}>{candidate.title || candidate.url}</button><button className="browser-tab-close" type="button" onClick={() => void closeTab(candidate)} aria-label={`Close ${candidate.title || candidate.url}`}>×</button></div>)}</div>}
      <div className="tool-pane-header browser-header">
        <div><span className="eyebrow">Browser</span><h2>{tab?.title || "Chromium workspace"}</h2></div>
        <div className="browser-controls" aria-label="Browser controls">
          <button className="icon-button" type="button" disabled={!tab} onClick={() => void run(() => bridge!.browser.back(tab!.browserTabId))} aria-label="Back">←</button>
          <button className="icon-button" type="button" disabled={!tab} onClick={() => void run(() => bridge!.browser.forward(tab!.browserTabId))} aria-label="Forward">→</button>
          <button className="icon-button" type="button" disabled={!tab} onClick={() => void run(() => bridge!.browser.reload(tab!.browserTabId))} aria-label="Reload">↻</button>
        </div>
      </div>
      <form className="browser-address" onSubmit={(event) => void openUrl(event)}>
        <input aria-label="Browser URL" placeholder="Enter an http(s) URL" value={url} onChange={(event) => setUrl(event.target.value)} />
        <button className="primary-button" type="submit" disabled={!worktree || !url.trim() || busy}>{busy ? "Opening" : tab ? "Go" : "Open"}</button>
      </form>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className={`browser-surface${tab ? " has-tab" : ""}`} ref={surfaceRef}>
        {!tab && <div className="empty-pane browser-empty"><p className="empty-title">A browser that belongs to this worktree</p><p className="empty-detail">Open a local dev server or any trusted HTTP(S) page above. Its cookies stay isolated to this worktree and profile.</p></div>}
        {!worktree && <div className="empty-pane browser-empty"><p className="empty-title">Select a worktree first</p><p className="empty-detail">Browser tabs are restored per worktree, so the runtime needs a workspace before it can open Chromium.</p></div>}
      </div>
    </div>
  );
}

function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  return /^https?:\/\//iu.test(trimmed) ? trimmed : `http://${trimmed}`;
}
