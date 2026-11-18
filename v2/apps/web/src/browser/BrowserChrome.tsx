import type { BrowserTabProjection } from "@zli-v2/contracts";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { cx, IconButton } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";

/** What makes the browser pane look like a browser window of its own: whose it is, and how it closes. */
export type BrowserChromeOptions = {
  /** Shown at the right of the tab strip, such as the buddy's face and name. */
  owner: ReactNode;
  /** Its name, for the signed-in sites panel. */
  ownerName?: string;
  onClose(): void;
  /** A bar under the toolbar, such as who is in control. */
  banner?: ReactNode;
};

export type BrowserMenuItem = {
  label: string;
  hint?: string;
  onSelect(): void;
  disabled?: boolean;
  /** Draws a line above it. */
  divided?: boolean;
  pressed?: boolean;
};

/** The site's host without www, for the address bar and tab tiles. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./u, "");
  } catch {
    return "";
  }
}

const TILE_COLORS = ["#3157f5", "#0b8f6a", "#e01e5a", "#c56ff0", "#ff8a3d", "#24292f", "#2fbf8f", "#d4a017"];

/**
 * The site's own icon, as the page names it. Until it does, or when it cannot be loaded, a small square with the
 * site's first letter, in a color that stays the same for the site.
 */
function SiteTile({ url, favicon }: { url: string; favicon?: string | undefined }) {
  const [broken, setBroken] = useState<string>();
  const host = hostOf(url);
  if (favicon && broken !== favicon)
    return (
      <img
        className="chrome-favicon"
        src={favicon}
        alt=""
        width={16}
        height={16}
        draggable={false}
        referrerPolicy="no-referrer"
        onError={() => setBroken(favicon)}
      />
    );
  if (!host) return <Icon name="globe" size={13} />;
  let hash = 0;
  for (const character of host) hash = (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0;
  return (
    <span className="chrome-tile" style={{ background: TILE_COLORS[hash % TILE_COLORS.length] }} aria-hidden="true">
      {host[0]?.toUpperCase()}
    </span>
  );
}

/** The address without its scheme while the person is not typing in it, the way browsers show it. */
function displayUrl(url: string): { host: string; rest: string } {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { host: "", rest: url };
    const rest = `${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}`;
    return { host: parsed.host.replace(/^www\./u, ""), rest };
  } catch {
    return { host: "", rest: url };
  }
}

/**
 * A browser window's top: rounded tabs with the site's tile and title, a new-tab button and whose browser it
 * is; under it back, forward and reload, a rounded address bar, and a ⋯ menu. A thin bar shows loading.
 */
export function BrowserChromeHeader({
  options,
  tabs,
  activeTab,
  url,
  busy,
  onUrlChange,
  onSubmit,
  onSelectTab,
  onCloseTab,
  onNewTab,
  onBack,
  onForward,
  onReload,
  menu,
  onMenuOpenChange,
  inputRef,
  overlay,
}: {
  options: BrowserChromeOptions;
  tabs: readonly BrowserTabProjection[];
  activeTab: BrowserTabProjection | undefined;
  url: string;
  busy: boolean;
  onUrlChange(value: string): void;
  onSubmit(event: React.FormEvent): void;
  onSelectTab(tab: BrowserTabProjection): void;
  onCloseTab(tab: BrowserTabProjection): void;
  onNewTab(): void;
  onBack(): void;
  onForward(): void;
  onReload(): void;
  menu: readonly BrowserMenuItem[];
  /** The page is a native view drawn over everything, so it steps aside while the menu is open. */
  onMenuOpenChange(open: boolean): void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  /** A panel opened from the menu, drawn under the toolbar. */
  overlay?: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const setOpen = (open: boolean) => {
    setMenuOpen(open);
    onMenuOpenChange(open);
  };
  const setOpenRef = useRef(setOpen);
  setOpenRef.current = setOpen;
  useEffect(() => {
    if (!menuOpen) return undefined;
    const away = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpenRef.current(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpenRef.current(false);
      }
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [menuOpen]);
  const shown = displayUrl(url);
  const secure = url.startsWith("https://");
  const loading = activeTab?.status === "loading" || busy;
  return (
    <div className="chrome-head">
      <div className="chrome-tabs" role="tablist" aria-label="Browser tabs">
        {tabs.map((tab) => {
          const on = tab.browserTabId === activeTab?.browserTabId;
          const title = tab.title || hostOf(tab.url) || "New tab";
          return (
            <div key={tab.browserTabId} className={cx("chrome-tab", on && "is-on")}>
              <button
                type="button"
                role="tab"
                aria-selected={on}
                className="chrome-tab-main"
                title={tab.url}
                onClick={() => onSelectTab(tab)}
              >
                {tab.status === "loading" && !tab.favicon ? (
                  <span className="chrome-spinner" aria-hidden="true" />
                ) : (
                  <SiteTile url={tab.url} favicon={tab.favicon} />
                )}
                <span className="chrome-tab-title">{title}</span>
              </button>
              <button
                type="button"
                className="chrome-tab-x"
                aria-label={`Close ${title}`}
                onClick={() => onCloseTab(tab)}
              >
                <Icon name="x" size={11} />
              </button>
            </div>
          );
        })}
        <IconButton icon="plus" size="sm" iconSize={15} label="New tab" tooltip="New tab" onClick={onNewTab} />
        <div className="chrome-owner">
          {options.owner}
          <IconButton
            icon="x"
            size="sm"
            iconSize={14}
            label="Close browser"
            tooltip="Close"
            onClick={options.onClose}
          />
        </div>
      </div>
      <div className="chrome-bar">
        <IconButton icon="arrowLeft" size="sm" iconSize={15} label="Back" disabled={!activeTab} onClick={onBack} />
        <IconButton
          icon="arrowRight"
          size="sm"
          iconSize={15}
          label="Forward"
          disabled={!activeTab}
          onClick={onForward}
        />
        <IconButton icon="reload" size="sm" iconSize={14} label="Reload" disabled={!activeTab} onClick={onReload} />
        <form className="chrome-omni" onSubmit={onSubmit}>
          <span className="chrome-omni-icon" title={secure ? "Secure connection" : undefined}>
            <Icon name={secure ? "lock" : "globe"} size={12} />
          </span>
          <input
            ref={inputRef}
            aria-label="Address"
            placeholder={url && !editing ? "" : "Type a web address"}
            spellCheck={false}
            value={editing ? url : ""}
            onFocus={(event) => {
              setEditing(true);
              const field = event.currentTarget;
              requestAnimationFrame(() => field.select());
            }}
            onBlur={() => setEditing(false)}
            onChange={(event) => onUrlChange(event.target.value)}
          />
          {!editing && url ? (
            <span className="chrome-omni-shown" aria-hidden="true">
              <span className="chrome-omni-host">{shown.host}</span>
              <span className="chrome-omni-rest">{shown.rest}</span>
            </span>
          ) : null}
        </form>
        <div className="chrome-menu-wrap" ref={menuRef}>
          <IconButton
            icon="more"
            size="sm"
            iconSize={15}
            label="Browser menu"
            tooltip="More"
            pressed={menuOpen}
            onClick={() => setOpen(!menuOpen)}
          />
          {menuOpen ? (
            <div className="chrome-menu" role="menu">
              {menu.map((item) => (
                <div key={item.label}>
                  {item.divided ? <div className="chrome-menu-sep" /> : null}
                  <button
                    type="button"
                    role="menuitem"
                    className={cx("chrome-menu-item", item.pressed && "is-on")}
                    disabled={item.disabled}
                    onClick={() => {
                      setOpen(false);
                      item.onSelect();
                    }}
                  >
                    {item.label}
                    {item.hint ? <span className="chrome-menu-hint">{item.hint}</span> : null}
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </div>
        {loading ? <span className="chrome-load" aria-hidden="true" /> : null}
      </div>
      {options.banner}
      {overlay}
    </div>
  );
}

/**
 * The sites that keep sign-ins in this browser, each with Sign out, and Forget all. Signing out clears that
 * site's cookies and storage in this profile only.
 */
export function SignedInSites({
  owner,
  load,
  forget,
  onClose,
}: {
  owner: string;
  load(): Promise<readonly { site: string; cookies: number }[]>;
  forget(site?: string): Promise<void>;
  onClose(): void;
}) {
  const [sites, setSites] = useState<readonly { site: string; cookies: number }[]>();
  const [error, setError] = useState<string>();
  const loadRef = useRef(load);
  loadRef.current = load;
  const refresh = () =>
    void loadRef
      .current()
      .then(setSites)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "The sites could not be read."));
  // Read once when the panel opens.
  useEffect(refresh, []);
  return (
    <section className="chrome-sites" aria-label="Signed-in sites">
      <header className="chrome-sites-head">
        <h4>Signed-in sites</h4>
        <IconButton icon="x" size="xs" label="Close signed-in sites" onClick={onClose} />
      </header>
      <p className="chrome-sites-note">
        {owner} stays signed in here between jobs. Your own browser and the other buddies are not affected.
      </p>
      {error ? <p className="chrome-sites-note is-error">{error}</p> : null}
      {sites === undefined ? <p className="chrome-sites-note">Reading…</p> : null}
      {sites?.length === 0 ? <p className="chrome-sites-note">No sites keep a sign-in here yet.</p> : null}
      <ul className="chrome-sites-list">
        {sites?.map((entry) => (
          <li key={entry.site} className="chrome-site">
            <SiteTile url={`https://${entry.site}`} />
            <span className="chrome-site-name">
              {entry.site}
              <span>
                {entry.cookies} cookie{entry.cookies === 1 ? "" : "s"}
              </span>
            </span>
            <button type="button" className="chrome-site-out" onClick={() => void forget(entry.site).then(refresh)}>
              Sign out
            </button>
          </li>
        ))}
      </ul>
      {sites && sites.length > 0 ? (
        <button type="button" className="chrome-sites-forget" onClick={() => void forget().then(refresh)}>
          Forget all sign-ins
        </button>
      ) : null}
    </section>
  );
}
