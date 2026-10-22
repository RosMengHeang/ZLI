import {
  BROWSER_DEVICE_PRESETS,
  type BrowserTabProjection,
  type BrowserViewport,
  type RuntimeProjection,
  type WorktreeProjection,
} from "@zli-v2/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRuntime, useRuntimeSelector } from "../runtime/RuntimeProvider.js";
import { Button, IconButton } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { EmptyState, PaneHeader } from "../ui/Pane.js";
import "./browser.css";

const DEFAULT_PROFILE_ID = "00000000-0000-4000-8000-000000000002";
const DEFAULT_DEVICE_ID = "iphone-15";
const CUSTOM_DEVICE = "custom";
/** How long a reveal waits for its tab to reach the projection before the pane falls back to normal restore. */
const REVEAL_WAIT_MS = 3_000;

export type BrowserReveal = { browserTabId: string; worktreeId: string; key: number };

type Props = {
  worktree: WorktreeProjection | undefined;
  /** True while app UI (dialogs, palette) must sit above the pane; the native view cannot be layered under DOM. */
  obscured?: boolean;
  /** A tab an agent opened that the pane should bring to the front once it belongs to this worktree. */
  reveal?: BrowserReveal | undefined;
};

const selectBrowserTabs = (projection: RuntimeProjection | undefined) => projection?.browserTabs;

export function BrowserPane({ worktree, obscured = false, reveal }: Props) {
  const { bridge } = useRuntime();
  const browserTabs = useRuntimeSelector(selectBrowserTabs);
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
    () => browserTabs?.filter((candidate) => candidate.worktreeId === worktreeId) ?? [],
    [browserTabs, worktreeId],
  );
  const restoredTab = worktreeTabs.find((candidate) => candidate.active) ?? worktreeTabs[0];
  const [handledRevealKey, setHandledRevealKey] = useState<number>();
  const pendingReveal =
    reveal && reveal.key !== handledRevealKey && reveal.worktreeId === worktreeId ? reveal : undefined;

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
    if (!bridge || !worktreeId || !restoredTab || tab || pendingReveal) return;
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
  }, [activateInSurface, bridge, pendingReveal, restoredTab, showUrl, tab, worktreeId]);

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
    const next = browserTabs?.find((candidate) => candidate.browserTabId === tab.browserTabId);
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
      next.loadError === tab.loadError &&
      sameViewport(next.viewport, tab.viewport)
    )
      return;
    const editing = urlEditedRef.current && document.activeElement === urlInputRef.current;
    if (next.url !== tab.url && !editing) showUrl(next.url);
    setTab(next);
  }, [browserTabs, showUrl, tab]);

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

  const selectTabRef = useRef(selectTab);
  selectTabRef.current = selectTab;
  const pendingRevealTab = pendingReveal
    ? worktreeTabs.find((candidate) => candidate.browserTabId === pendingReveal.browserTabId)
    : undefined;
  const revealingKeyRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!pendingReveal) return;
    if (!pendingRevealTab) {
      const timer = window.setTimeout(() => setHandledRevealKey(pendingReveal.key), REVEAL_WAIT_MS);
      return () => window.clearTimeout(timer);
    }
    if (revealingKeyRef.current === pendingReveal.key) return;
    revealingKeyRef.current = pendingReveal.key;
    // The reveal stays pending until the tab is shown, which keeps the restore effect from
    // activating the previously active tab in the meantime.
    const shown =
      pendingRevealTab.browserTabId === tab?.browserTabId ? Promise.resolve() : selectTabRef.current(pendingRevealTab);
    void shown.finally(() => setHandledRevealKey(pendingReveal.key));
    return undefined;
  }, [pendingReveal, pendingRevealTab, tab?.browserTabId]);

  const setViewport = (viewport: BrowserViewport | null) =>
    void run((activeBridge, activeTab) => activeBridge.browser.setViewport(activeTab.browserTabId, viewport));
  const devicePreset = tab?.viewport ? findPreset(tab.viewport) : undefined;
  const toggleDevice = () => {
    if (tab?.viewport) setViewport(null);
    else {
      const preset = BROWSER_DEVICE_PRESETS.find((candidate) => candidate.id === DEFAULT_DEVICE_ID);
      if (preset) setViewport(preset.viewport);
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
      <PaneHeader icon="globe" title={tab?.title || "Browser"} detail={worktree?.branch}>
        {tab && worktreeTabs.length === 1 ? (
          <IconButton
            icon="x"
            size="sm"
            iconSize={14}
            onClick={() => void closeTab(tab)}
            disabled={busy}
            label={`Close ${tab.title || tab.url}`}
            tooltip="Close tab"
          />
        ) : null}
        {worktree ? (
          <IconButton
            icon="plus"
            size="sm"
            iconSize={15}
            onClick={() => void newTab()}
            disabled={busy}
            label="New browser tab"
            tooltip="New tab"
          />
        ) : null}
      </PaneHeader>
      {worktree && worktreeTabs.length > 1 && (
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
                title={candidate.url}
              >
                <Icon name="globe" size={12} />
                <span>{candidate.title || candidate.url || "New tab"}</span>
              </button>
              <IconButton
                className="browser-tab-close"
                icon="x"
                size="xs"
                iconSize={11}
                onClick={() => void closeTab(candidate)}
                label={`Close ${candidate.title || candidate.url}`}
                tooltip="Close tab"
              />
            </div>
          ))}
        </div>
      )}
      <div className="browser-toolbar">
        <nav className="browser-controls" aria-label="Browser controls">
          <IconButton
            icon="arrowLeft"
            size="sm"
            iconSize={15}
            disabled={!tab}
            onClick={() => void run((activeBridge, activeTab) => activeBridge.browser.back(activeTab.browserTabId))}
            label="Back"
            tooltip="Back"
          />
          <IconButton
            icon="arrowRight"
            size="sm"
            iconSize={15}
            disabled={!tab}
            onClick={() => void run((activeBridge, activeTab) => activeBridge.browser.forward(activeTab.browserTabId))}
            label="Forward"
            tooltip="Forward"
          />
          <IconButton
            icon="reload"
            size="sm"
            iconSize={14}
            disabled={!tab}
            onClick={() => void run((activeBridge, activeTab) => activeBridge.browser.reload(activeTab.browserTabId))}
            label="Reload"
            tooltip="Reload"
          />
        </nav>
        <form className="browser-address" onSubmit={(event) => void openUrl(event)}>
          <span className="browser-address-icon">
            <Icon name="globe" size={13} />
          </span>
          <input
            ref={urlInputRef}
            aria-label="Browser URL"
            placeholder="localhost:3000 or https://…"
            value={url}
            onChange={(event) => {
              urlEditedRef.current = true;
              setUrlState(event.target.value);
            }}
          />
          <Button variant="primary" size="sm" type="submit" disabled={!worktree || !url.trim() || busy}>
            {busy ? "Opening" : tab ? "Go" : "Open"}
          </Button>
        </form>
        <IconButton
          icon="smartphone"
          size="sm"
          iconSize={14}
          disabled={!tab}
          onClick={toggleDevice}
          pressed={Boolean(tab?.viewport)}
          label="Device size"
          tooltip={tab?.viewport ? "Back to full panel size" : "Preview at a device size"}
        />
        <IconButton
          icon="code"
          size="sm"
          iconSize={14}
          disabled={!tab}
          onClick={() =>
            void run((activeBridge, activeTab) => activeBridge.browser.openDevTools(activeTab.browserTabId))
          }
          label="Open browser developer tools"
          tooltip="Open DevTools in a window"
        />
      </div>
      {tab?.viewport ? (
        <div className="browser-device-bar">
          <label className="select-ghost" data-tooltip="Device">
            <select
              aria-label="Device"
              value={devicePreset?.id ?? CUSTOM_DEVICE}
              onChange={(event) => {
                const preset = BROWSER_DEVICE_PRESETS.find((candidate) => candidate.id === event.target.value);
                if (preset) setViewport(preset.viewport);
              }}
            >
              {devicePreset ? null : <option value={CUSTOM_DEVICE}>Custom</option>}
              {BROWSER_DEVICE_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}
                </option>
              ))}
            </select>
            <Icon name="chevronDown" size={12} />
          </label>
          <span className="browser-device-size">
            {tab.viewport.width} × {tab.viewport.height}
            {tab.viewport.deviceScaleFactor && tab.viewport.deviceScaleFactor !== 1
              ? ` · ${tab.viewport.deviceScaleFactor}x`
              : ""}
          </span>
          <IconButton
            icon="rotate"
            size="sm"
            iconSize={14}
            onClick={() => {
              const current = tab.viewport;
              if (current) setViewport({ ...current, width: current.height, height: current.width });
            }}
            label="Rotate"
            tooltip="Rotate"
          />
          <Button variant="ghost" size="sm" onClick={() => setViewport(null)} tooltip="Back to full panel size">
            Fit panel
          </Button>
        </div>
      ) : null}
      {(error ?? tab?.loadError) && (
        <div className="banner banner-danger" role="alert">
          <Icon name="alert" size={14} />
          <span className="banner-message">{error ?? tab?.loadError}</span>
        </div>
      )}
      <div className={`browser-surface${tab ? " has-tab" : ""}`} ref={surfaceRef}>
        {!worktree ? (
          <EmptyState
            className="browser-empty"
            icon="globe"
            title="Select a worktree first"
            detail="Browser tabs are restored per worktree, so the runtime needs a workspace before it can open Chromium."
          />
        ) : !tab ? (
          <EmptyState
            className="browser-empty"
            icon="globe"
            title="Open a page in this worktree"
            detail="Type a local dev server address or any HTTP(S) URL above. Cookies and storage stay separate for each worktree."
          />
        ) : null}
      </div>
    </div>
  );
}

function sameViewport(left: BrowserViewport | undefined, right: BrowserViewport | undefined) {
  if (!left || !right) return left === right;
  return (
    left.width === right.width &&
    left.height === right.height &&
    left.deviceScaleFactor === right.deviceScaleFactor &&
    left.mobile === right.mobile
  );
}

function findPreset(viewport: BrowserViewport) {
  return BROWSER_DEVICE_PRESETS.find((preset) => sameViewport(preset.viewport, viewport));
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
