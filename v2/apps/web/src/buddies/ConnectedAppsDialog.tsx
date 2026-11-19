import {
  CONNECTED_APP_CATALOG,
  CONNECTED_APP_GROUPS,
  CONNECTED_APP_ID,
  type ConnectedAppAccount,
  type ConnectedAppEntry,
  type ConnectedAppGroup,
  ConnectedAppsStatus,
  RECOMMENDED_APPS,
} from "@zli-v2/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";

import { openExternalLink } from "../review/links.js";
import { makeCommandId } from "../runtime/commandId.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";
import { ConnectorLogo } from "../settings/connectorLogos.js";
import { Button, IconButton } from "../ui/Button.js";
import { Dialog } from "../ui/Dialog.js";
import { Icon } from "../ui/Icon.js";
import "./connectedApps.css";

/** Where a Composio key comes from: Connect → Settings → Sessions & API Key gives a ck_ key. */
const KEY_PAGE = "https://dashboard.composio.dev";
/** While a sign-in is open in the browser, how often to look whether it finished, and for how long. */
const WATCH_EVERY_MS = 4_000;
const WATCH_FOR_MS = 3 * 60_000;
/** Each group shows this many until "View all". */
const PER_GROUP = 6;

type Dispatch = (request: unknown) => Promise<unknown>;
type Filter = "all" | "connected" | ConnectedAppGroup;

async function send(dispatch: Dispatch, command: Record<string, unknown>): Promise<unknown> {
  const response = (await dispatch({ protocolVersion: 1, commandId: makeCommandId(), command })) as
    | { accepted: true; result: unknown }
    | { accepted: false; error: { message: string } }
    | undefined;
  if (!response) throw new Error("ZLI is not connected to its runtime.");
  if (!response.accepted) throw new Error(response.error.message);
  return response.result;
}

const status = async (dispatch: Dispatch, command: Record<string, unknown>) =>
  ConnectedAppsStatus.parse(await send(dispatch, command));

const BY_ID = new Map(CONNECTED_APP_CATALOG.map((entry) => [entry.app, entry]));

export function appTitle(app: string): string {
  return BY_ID.get(app)?.title ?? app.charAt(0).toUpperCase() + app.slice(1).replace(/_/gu, " ");
}

function entryOf(app: string): ConnectedAppEntry {
  return BY_ID.get(app) ?? { app, title: appTitle(app), group: "Projects and docs", blurb: "Connected on Composio" };
}

/**
 * Every app the team can use, through Composio, as a catalog: search, groups, and one Connect per app. Until a
 * Composio key is saved the catalog still shows, with the key asked for on top and Connect waiting for it.
 */
export function ConnectedAppsDialog({ onClose }: { onClose(): void }) {
  const { dispatch, bridge } = useRuntime();
  const [state, setState] = useState<ConnectedAppsStatus>();
  const [loading, setLoading] = useState(true);
  const [key, setKey] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [busy, setBusy] = useState<string>();
  const [problem, setProblem] = useState<string>();
  /** The app whose sign-in is open in the browser. */
  const [waitingFor, setWaitingFor] = useState<string>();
  const keyRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const run = useCallback(async (id: string, work: () => Promise<void>) => {
    setBusy(id);
    setProblem(undefined);
    try {
      await work();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(undefined);
    }
  }, []);

  // A quiet re-read: no spinner, and a failed read keeps what is on screen.
  const reread = useCallback(async () => {
    try {
      setState(await status(dispatch, { type: "mcp.apps.status" }));
    } catch {
      // The next read, or the person's next click, says what went wrong.
    }
  }, [dispatch]);

  useEffect(() => {
    void run("load", async () => setState(await status(dispatch, { type: "mcp.apps.status" }))).finally(() =>
      setLoading(false),
    );
  }, [dispatch, run]);

  // Escape closes it even when focus has left it, as it does after a button turns into a spinner.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Coming back from the browser, or every few seconds while a sign-in is open, shows the app as connected.
  useEffect(() => {
    if (!waitingFor) return;
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (Date.now() - started > WATCH_FOR_MS) setWaitingFor(undefined);
      else void reread();
    }, WATCH_EVERY_MS);
    const onFocus = () => void reread();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [waitingFor, reread]);

  const configured = state?.configured ?? false;
  const accounts = state?.accounts ?? [];
  const live = new Set(accounts.filter(isLive).map((account) => account.app));
  useEffect(() => {
    if (waitingFor && live.has(waitingFor)) setWaitingFor(undefined);
  });

  const connect = (app: string) =>
    run(`connect:${app}`, async () => {
      const link = z.object({ url: z.string() }).parse(await send(dispatch, { type: "mcp.apps.connect", app }));
      const failed = await openExternalLink(bridge, link.url);
      if (failed) throw new Error(failed);
      setWaitingFor(app);
    });
  const disconnect = (account: ConnectedAppAccount) =>
    run(`off:${account.accountId}`, async () =>
      setState(await status(dispatch, { type: "mcp.apps.disconnect", accountId: account.accountId })),
    );
  const saveKey = (value: string) =>
    run("key", async () => {
      setState(await status(dispatch, { type: "mcp.apps.key", key: value }));
      setKey("");
    });

  const needle = query.trim().toLowerCase();
  const matches = (entry: ConnectedAppEntry) =>
    !needle || `${entry.title} ${entry.app} ${entry.blurb} ${entry.group}`.toLowerCase().includes(needle);
  // Apps connected outside the catalog still show among the connected ones.
  const connectedApps = [...new Set(accounts.map((account) => account.app))].map(entryOf);
  const customId = needle.replace(/\s+/gu, "_");
  const offerCustom =
    configured && needle && CONNECTED_APP_ID.test(customId) && !BY_ID.has(customId) && !live.has(customId);

  const rowProps = {
    configured,
    ready: state !== undefined,
    busy,
    accounts,
    waitingFor,
    onConnect: (app: string) => void connect(app),
    onDisconnect: (account: ConnectedAppAccount) => void disconnect(account),
  };

  let sections: { title: string; apps: ConnectedAppEntry[]; more?: Filter }[];
  if (filter === "connected") sections = [{ title: "Connected", apps: connectedApps.filter(matches) }];
  else if (filter !== "all")
    sections = [{ title: filter, apps: CONNECTED_APP_CATALOG.filter((e) => e.group === filter && matches(e)) }];
  else if (needle) sections = [{ title: "Results", apps: CONNECTED_APP_CATALOG.filter(matches) }];
  else
    sections = [
      { title: "Recommended for you", apps: RECOMMENDED_APPS.map(entryOf) },
      ...CONNECTED_APP_GROUPS.map((group) => {
        const apps = CONNECTED_APP_CATALOG.filter((entry) => entry.group === group);
        return apps.length > PER_GROUP
          ? { title: group, apps: apps.slice(0, PER_GROUP), more: group as Filter }
          : { title: group, apps };
      }),
    ];
  const empty = sections.every((section) => section.apps.length === 0);

  const errorLine =
    problem || state?.problem ? (
      <p className="inline-error" role="alert">
        <Icon name="alert" size={13} />
        {problem ?? state?.problem}
      </p>
    ) : state?.warning ? (
      <p className="inline-error">
        <Icon name="alert" size={13} />
        {state.warning}
      </p>
    ) : null;

  return (
    <Dialog
      label="Connect apps"
      size="lg"
      className="apps-dialog"
      initialFocusRef={configured ? searchRef : keyRef}
      showClose={false}
      // Opened from the Buddies list, which the shell does not close on Escape, so it closes itself.
      stacked
      onClose={onClose}
    >
      <header className="apps-head">
        <div className="apps-head-text">
          <h2 className="apps-title">Connect apps</h2>
          <p className="apps-sub">Sign in once, and every buddy can use the app.</p>
        </div>
        {loading ? <span className="spinner" role="status" aria-label="Checking your apps" /> : null}
        {live.size > 0 ? (
          <button
            type="button"
            className={`apps-count${filter === "connected" ? " is-on" : ""}`}
            aria-pressed={filter === "connected"}
            onClick={() => setFilter((current) => (current === "connected" ? "all" : "connected"))}
          >
            <span className="apps-count-logos" aria-hidden="true">
              {[...live].slice(0, 4).map((app) => (
                <AppLogo key={app} app={app} size={20} />
              ))}
            </span>
            {live.size} connected
            <Icon name="chevronRight" size={13} />
          </button>
        ) : null}
        <IconButton label="Close" icon="x" size="sm" onClick={onClose} />
      </header>

      {state && !configured ? (
        <form
          className="apps-key"
          onSubmit={(event) => {
            event.preventDefault();
            if (key.trim()) void saveKey(key.trim());
          }}
        >
          <Icon name="lock" size={16} />
          <div className="apps-key-text">
            <b>Add your Composio key to start connecting</b>
            <span>
              It stays on this computer.{" "}
              <button
                type="button"
                className="apps-link"
                onClick={() => void openExternalLink(bridge, KEY_PAGE).then((failed) => failed && setProblem(failed))}
              >
                Get a free key
                <Icon name="externalLink" size={11} />
              </button>
            </span>
          </div>
          <input
            ref={keyRef}
            className="input is-mono apps-key-input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-label="Composio key"
            placeholder="ck_... or ak_..."
            value={key}
            onChange={(event) => setKey(event.target.value)}
          />
          <Button variant="primary" type="submit" loading={busy === "key"} disabled={!key.trim()}>
            Save key
          </Button>
        </form>
      ) : null}

      <div className="apps-tools">
        <label className="apps-search">
          <Icon name="search" size={14} />
          <input
            ref={searchRef}
            type="search"
            placeholder="Search apps"
            aria-label="Search apps"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <fieldset className="apps-chips" aria-label="Show">
          {(["all", ...(live.size > 0 ? (["connected"] as const) : []), ...CONNECTED_APP_GROUPS] as Filter[]).map(
            (value) => (
              <button
                key={value}
                type="button"
                className={`apps-chip${filter === value ? " is-on" : ""}`}
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {value === "all" ? "All" : value === "connected" ? "Connected" : value}
              </button>
            ),
          )}
        </fieldset>
      </div>

      {waitingFor ? (
        <p className="apps-waiting" role="status">
          <span className="spinner" aria-hidden="true" />
          Finish signing in to {appTitle(waitingFor)} in your browser. This updates on its own.
        </p>
      ) : null}
      {errorLine ? <div className="apps-error">{errorLine}</div> : null}

      <div className="apps-body">
        {sections.map((section) =>
          section.apps.length > 0 ? (
            <section key={section.title} className="apps-section" aria-label={section.title}>
              <div className="apps-section-head">
                <h3 className="apps-heading">{section.title}</h3>
                {section.more ? (
                  <button type="button" className="apps-viewall" onClick={() => setFilter(section.more as Filter)}>
                    View all
                  </button>
                ) : null}
              </div>
              <ul className="apps-list">
                {section.apps.map((entry) => (
                  <AppRow key={entry.app} entry={entry} {...rowProps} />
                ))}
              </ul>
            </section>
          ) : null,
        )}
        {offerCustom ? (
          <section className="apps-section" aria-label="Another app">
            <h3 className="apps-heading">Another app</h3>
            <ul className="apps-list">
              <AppRow
                entry={{
                  app: customId,
                  title: appTitle(customId),
                  group: "Projects and docs",
                  blurb: "By its Composio id",
                }}
                {...rowProps}
              />
            </ul>
          </section>
        ) : null}
        {empty && !offerCustom ? (
          <p className="apps-empty">
            {filter === "connected" ? "Nothing connected yet." : `No app called "${query.trim()}" here.`}
          </p>
        ) : null}
      </div>

      {configured ? (
        <footer className="apps-foot">
          <button
            type="button"
            className="apps-link is-quiet"
            disabled={busy !== undefined}
            onClick={() => void saveKey("")}
          >
            Remove Composio key
          </button>
          <span className="apps-spacer" />
          <Button onClick={onClose}>Done</Button>
        </footer>
      ) : null}
    </Dialog>
  );
}

function AppRow({
  entry,
  configured,
  ready,
  busy,
  accounts,
  waitingFor,
  onConnect,
  onDisconnect,
}: {
  entry: ConnectedAppEntry;
  configured: boolean;
  ready: boolean;
  busy: string | undefined;
  accounts: readonly ConnectedAppAccount[];
  waitingFor: string | undefined;
  onConnect(app: string): void;
  onDisconnect(account: ConnectedAppAccount): void;
}) {
  const mine = accounts.filter((account) => account.app === entry.app);
  const active = mine.find(isLive);
  const pending = !active && (waitingFor === entry.app || mine.some((account) => !isLive(account)));
  return (
    <li className={`apps-item${active ? " is-live" : ""}`}>
      <AppLogo app={entry.app} size={36} />
      <span className="apps-item-text">
        <span className="apps-item-name">{entry.title}</span>
        <span className="apps-item-blurb">{active?.label ?? entry.blurb}</span>
      </span>
      {active ? (
        <span className="apps-item-actions">
          <span className="apps-state is-live">
            <Icon name="check" size={12} />
            Connected
          </span>
          <IconButton
            label={`Disconnect ${entry.title}`}
            tooltip="Disconnect"
            icon="x"
            size="xs"
            disabled={busy !== undefined}
            onClick={() => onDisconnect(active)}
          />
        </span>
      ) : (
        <Button
          size="sm"
          className="apps-connect"
          loading={busy === `connect:${entry.app}`}
          disabled={!configured || !ready || (busy !== undefined && busy !== `connect:${entry.app}`)}
          title={configured ? undefined : "Add your Composio key first"}
          onClick={() => onConnect(entry.app)}
        >
          {pending ? "Finish sign-in" : "Connect"}
        </Button>
      )}
    </li>
  );
}

function isLive(account: ConnectedAppAccount): boolean {
  return account.status === "active";
}

/** Composio's own logo for the app, on a light tile; the built-in mark or its letter if that does not load. */
export function AppLogo({ app, size }: { app: string; size: number }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="apps-logo" style={{ width: size, height: size }}>
      {failed ? (
        <ConnectorLogo id={app} title={appTitle(app)} size={Math.round(size * 0.7)} />
      ) : (
        <img
          src={`https://logos.composio.dev/api/${encodeURIComponent(app)}`}
          alt=""
          loading="lazy"
          draggable={false}
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}
