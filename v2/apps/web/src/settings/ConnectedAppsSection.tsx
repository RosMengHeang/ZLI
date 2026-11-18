import { type ConnectedAppAccount, ConnectedAppsStatus } from "@zli-v2/contracts";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";

import { openExternalLink } from "../review/links.js";
import { makeCommandId } from "../runtime/commandId.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";
import { Button } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { ConnectorLogo } from "./connectorLogos.js";

/** The apps most people connect first, by Composio's id. Any other app can be named below. */
export const POPULAR_APPS: ReadonlyArray<{ app: string; title: string; logo?: string }> = [
  { app: "gmail", title: "Gmail" },
  { app: "googlecalendar", title: "Google Calendar" },
  { app: "googledrive", title: "Google Drive" },
  { app: "slack", title: "Slack", logo: "slack" },
  { app: "github", title: "GitHub", logo: "github" },
  { app: "notion", title: "Notion", logo: "notion" },
  { app: "linear", title: "Linear", logo: "linear" },
  { app: "outlook", title: "Outlook" },
  { app: "hubspot", title: "HubSpot" },
  { app: "jira", title: "Jira", logo: "atlassian" },
  { app: "discord", title: "Discord" },
  { app: "airtable", title: "Airtable", logo: "airtable" },
];

const KEY_PAGE = "https://dashboard.composio.dev";

type Dispatch = (request: unknown) => Promise<unknown>;

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

export function appTitle(app: string): string {
  return POPULAR_APPS.find((entry) => entry.app === app)?.title ?? app.charAt(0).toUpperCase() + app.slice(1);
}

/**
 * Apps connected through Composio. The person saves a Composio key once and signs in to each app once in their
 * browser; every buddy and agent can then use those apps.
 */
export function ConnectedAppsSection() {
  const { dispatch, bridge } = useRuntime();
  const [state, setState] = useState<ConnectedAppsStatus>();
  const [key, setKey] = useState("");
  const [other, setOther] = useState("");
  const [busy, setBusy] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const [notice, setNotice] = useState<string>();

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

  const refresh = useCallback(
    () => run("refresh", async () => setState(await status(dispatch, { type: "mcp.apps.status" }))),
    [dispatch, run],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const connect = (app: string) =>
    run(`connect:${app}`, async () => {
      const link = z.object({ url: z.string() }).parse(await send(dispatch, { type: "mcp.apps.connect", app }));
      const failed = await openExternalLink(bridge, link.url);
      setNotice(failed ?? `Finish signing in to ${appTitle(app)} in your browser, then press Refresh.`);
    });

  if (!state)
    return problem ? (
      <p className="inline-error" role="alert">
        <Icon name="alert" size={13} />
        {problem}
      </p>
    ) : (
      <p className="loading-line">
        <span className="spinner" aria-hidden="true" />
        Loading connected apps
      </p>
    );

  if (!state.configured)
    return (
      <form
        className="connected-apps-key"
        onSubmit={(event) => {
          event.preventDefault();
          void run("key", async () => {
            setState(await status(dispatch, { type: "mcp.apps.key", key }));
            setKey("");
          });
        }}
      >
        <p className="connected-apps-lead">
          Gmail, Slack, GitHub, Notion, Linear and hundreds more, through Composio. Add your Composio project key once,
          sign in to each app once, and every buddy can use them.
        </p>
        <label className="connected-apps-field">
          <span>Composio project key</span>
          <input
            className="input input-sm is-mono"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="ak_..."
            value={key}
            onChange={(event) => setKey(event.target.value)}
          />
        </label>
        <div className="connector-form-actions">
          <button
            type="button"
            className="connector-link"
            onClick={() => void openExternalLink(bridge, KEY_PAGE).then(setNotice)}
          >
            <Icon name="externalLink" size={12} />
            Get a key
          </button>
          <span className="connector-spacer" />
          <Button size="sm" variant="primary" type="submit" loading={busy === "key"} disabled={!key.trim()}>
            Save key
          </Button>
        </div>
        {problem ? (
          <p className="inline-error" role="alert">
            <Icon name="alert" size={13} />
            {problem}
          </p>
        ) : null}
        {notice ? <p className="settings-footnote">{notice}</p> : null}
      </form>
    );

  const connected = new Set(state.accounts.filter(isLive).map((account) => account.app));
  return (
    <div className="connected-apps">
      {state.accounts.length > 0 ? (
        <ul className="connected-apps-accounts" aria-label="Connected accounts">
          {state.accounts.map((account) => (
            <li key={account.accountId} className="connected-apps-account">
              <AppLogo app={account.app} size={24} />
              <span className="connected-apps-account-name">
                <strong>{appTitle(account.app)}</strong>
                {account.label ? <span>{account.label}</span> : null}
              </span>
              <span className={`connected-apps-status${isLive(account) ? " is-live" : ""}`}>
                {isLive(account) ? "Connected" : statusWord(account.status)}
              </span>
              <Button
                size="xs"
                variant="ghost"
                loading={busy === `off:${account.accountId}`}
                aria-label={`Disconnect ${appTitle(account.app)}`}
                onClick={() =>
                  void run(`off:${account.accountId}`, async () =>
                    setState(await status(dispatch, { type: "mcp.apps.disconnect", accountId: account.accountId })),
                  )
                }
              >
                Disconnect
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="settings-empty">No apps yet. Connect one below; every buddy can use it right away.</p>
      )}
      <ul className="connected-apps-grid" aria-label="Apps to connect">
        {POPULAR_APPS.map((entry) => (
          <li key={entry.app}>
            <button
              type="button"
              className="connected-apps-tile"
              aria-label={`${connected.has(entry.app) ? "Add another" : "Connect"} ${entry.title}`}
              disabled={busy === `connect:${entry.app}`}
              onClick={() => void connect(entry.app)}
            >
              <AppLogo app={entry.app} size={20} />
              <span>{entry.title}</span>
              {connected.has(entry.app) ? <Icon name="check" size={12} /> : <Icon name="plus" size={12} />}
            </button>
          </li>
        ))}
      </ul>
      <form
        className="connected-apps-other"
        onSubmit={(event) => {
          event.preventDefault();
          if (other.trim()) void connect(other.trim().toLowerCase());
        }}
      >
        <input
          className="input input-sm"
          spellCheck={false}
          placeholder="Another app, by its Composio name (such as asana)"
          aria-label="Another app"
          value={other}
          onChange={(event) => setOther(event.target.value)}
        />
        <Button size="sm" type="submit" disabled={!other.trim()}>
          Connect
        </Button>
      </form>
      <div className="connector-form-actions">
        <Button size="sm" variant="ghost" icon="reload" loading={busy === "refresh"} onClick={() => void refresh()}>
          Refresh
        </Button>
        <span className="connector-spacer" />
        <button
          type="button"
          className="connector-link"
          onClick={() =>
            void run("key", async () => setState(await status(dispatch, { type: "mcp.apps.key", key: "" })))
          }
        >
          Remove key
        </button>
      </div>
      {state.problem || problem ? (
        <p className="inline-error" role="alert">
          <Icon name="alert" size={13} />
          {problem ?? state.problem}
        </p>
      ) : null}
      {notice ? <p className="settings-footnote">{notice}</p> : null}
    </div>
  );
}

function isLive(account: ConnectedAppAccount): boolean {
  return account.status === "active";
}

function statusWord(status: string): string {
  if (status === "initiated" || status === "initializing") return "Waiting for sign-in";
  if (status === "expired") return "Sign in again";
  if (status === "failed") return "Failed";
  return status;
}

function AppLogo({ app, size }: { app: string; size: number }) {
  const logo = POPULAR_APPS.find((entry) => entry.app === app)?.logo;
  return <ConnectorLogo id={logo ?? app} title={appTitle(app)} size={size} />;
}
