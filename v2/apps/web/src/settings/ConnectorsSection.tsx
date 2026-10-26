import {
  catalogEntryServer,
  catalogMissingField,
  catalogServer,
  catalogSignsIn,
  isHttpServer,
  MCP_CATALOG,
  MCP_CATALOG_CATEGORIES,
  type McpCatalogEntry,
  type McpCatalogField,
  type McpListResult,
  type McpServerConfig,
} from "@zli-v2/contracts";
import { useMemo, useRef, useState } from "react";

import { openExternalLink } from "../review/links.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";
import { Button } from "../ui/Button.js";
import { Field } from "../ui/Field.js";
import { Icon } from "../ui/Icon.js";
import { ConnectorLogo } from "./connectorLogos.js";
import { McpProjectsButton } from "./McpProjectPicker.js";
import { McpStatusDot } from "./McpStatusDot.js";
import {
  applyServer,
  healthFor,
  isWindows,
  type PendingSignIn,
  SIGN_IN_CANCELED,
  serverStatus,
  signedInText,
  signInFor,
  toolCountText,
  useMcpServers,
  withProjects,
} from "./mcpServers.js";
import "./connectors.css";

/** Where a connector stands for the person, which decides the card's button. */
export type ConnectorState =
  | { kind: "new" }
  | { kind: "pending"; server: McpServerConfig; signIn: PendingSignIn }
  | { kind: "off"; server: McpServerConfig }
  | { kind: "signed-out"; server: McpServerConfig }
  | { kind: "expired"; server: McpServerConfig }
  | { kind: "connected"; server: McpServerConfig; detail: string };

export function connectorState(
  entry: McpCatalogEntry,
  result: McpListResult,
  pending: Readonly<Record<string, PendingSignIn>>,
): ConnectorState {
  const server = catalogEntryServer(entry, result.servers);
  if (!server) return { kind: "new" };
  const signIn = pending[server.name];
  if (signIn) return { kind: "pending", server, signIn };
  if (!server.enabled) return { kind: "off", server };
  if (isHttpServer(server) && server.oauth) {
    const state = signInFor(result, server.name);
    const text = signedInText(state);
    if (text) return { kind: "connected", server, detail: text };
    return state?.expired ? { kind: "expired", server } : { kind: "signed-out", server };
  }
  return { kind: "connected", server, detail: entry.category === "local" ? "Added" : "Connected" };
}

/** Whether an entry matches the search box: every word appears in its name, title, description, or category. */
export function connectorMatches(entry: McpCatalogEntry, query: string): boolean {
  const category = MCP_CATALOG_CATEGORIES.find((item) => item.id === entry.category)?.label ?? "";
  const haystack = `${entry.id} ${entry.title} ${entry.description} ${category}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/u)
    .filter((word) => word.length > 0)
    .every((word) => haystack.includes(word));
}

type Form = { id: string; useToken: boolean; values: Record<string, string> };

/** The connector catalog on the Integrations Browse tab, filtered by the shared search. */
export function ConnectorsSection({ query }: { query: string }) {
  const { bridge } = useRuntime();
  const { state, reload, save, signIn, cancelSignIn, reopenSignIn, signOut, pending, test, testing } = useMcpServers();
  const [form, setForm] = useState<Form>();
  const [busy, setBusy] = useState<string>();
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const firstField = useRef<HTMLInputElement>(null);

  const result = state.status === "ready" ? state.result : undefined;
  const states = useMemo(() => {
    const map = new Map<string, ConnectorState>();
    if (result) for (const entry of MCP_CATALOG) map.set(entry.id, connectorState(entry, result, pending));
    return map;
  }, [result, pending]);

  if (state.status === "loading") {
    return (
      <p className="loading-line">
        <span className="spinner" aria-hidden="true" />
        Loading connectors
      </p>
    );
  }
  if (state.status === "error" || !result) {
    return (
      <>
        <p className="inline-error" role="alert">
          <Icon name="alert" size={13} />
          {state.status === "error" ? state.message : "Connectors could not be loaded."}
        </p>
        <div className="settings-actions">
          <Button size="sm" onClick={reload}>
            Try again
          </Button>
        </div>
      </>
    );
  }

  const servers = result.servers;
  const setProblem = (id: string, message: string | undefined) =>
    setProblems((current) => {
      const next = { ...current };
      if (message) next[id] = message;
      else delete next[id];
      return next;
    });

  const run = async (id: string, work: () => Promise<unknown>) => {
    setProblem(id, undefined);
    setBusy(id);
    try {
      await work();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== SIGN_IN_CANCELED) setProblem(id, message);
    } finally {
      setBusy((current) => (current === id ? undefined : current));
    }
  };

  /** Adds the server, then signs in when the entry needs it. A failed sign-in leaves it added with a Sign in button. */
  const connect = (entry: McpCatalogEntry, values: Record<string, string>, useToken: boolean) =>
    run(entry.id, async () => {
      const server = catalogServer(entry, values, { windows: isWindows(), useToken });
      const applied = applyServer(servers, server, undefined);
      if ("problem" in applied) throw new Error(applied.problem);
      await save(applied.servers);
      setForm(undefined);
      if (isHttpServer(server) && server.oauth) {
        setBusy(undefined);
        await signIn(server.name);
      }
    });

  const start = (entry: McpCatalogEntry, useToken = false) => {
    setConfirm(undefined);
    const fields = useToken && entry.tokenOption ? [entry.tokenOption.field] : entry.fields;
    if (fields.length === 0) {
      void connect(entry, {}, false);
      return;
    }
    setProblem(entry.id, undefined);
    setForm({ id: entry.id, useToken, values: {} });
    requestAnimationFrame(() => firstField.current?.focus());
  };

  const disconnect = (entry: McpCatalogEntry, server: McpServerConfig) =>
    run(entry.id, async () => {
      if (isHttpServer(server) && server.oauth && signInFor(result, server.name)?.signedIn) await signOut(server.name);
      await save(servers.filter((candidate) => candidate.name !== server.name));
      setConfirm(undefined);
    });

  const turnOn = (entry: McpCatalogEntry, server: McpServerConfig) =>
    run(entry.id, () =>
      save(servers.map((candidate) => (candidate.name === server.name ? { ...candidate, enabled: true } : candidate))),
    );

  const setProjects = (entry: McpCatalogEntry, server: McpServerConfig, projects: string[]) =>
    run(entry.id, () =>
      save(
        servers.map((candidate) => (candidate.name === server.name ? withProjects(candidate, projects) : candidate)),
      ),
    );

  const runTest = (id: string, name: string) =>
    run(id, async () => {
      const reply = await test(name);
      if (!reply.ok) throw new Error(reply.problem ?? "The server did not answer.");
    });

  const visible = MCP_CATALOG.filter((entry) => connectorMatches(entry, query));
  const groups = query.trim()
    ? [{ id: "results", label: "", entries: visible }]
    : MCP_CATALOG_CATEGORIES.map((category) => ({
        ...category,
        entries: visible.filter((entry) => entry.category === category.id),
      })).filter((group) => group.entries.length > 0);

  const renderForm = (entry: McpCatalogEntry, current: Form) => {
    const fields: readonly McpCatalogField[] =
      current.useToken && entry.tokenOption ? [entry.tokenOption.field] : entry.fields;
    return (
      <form
        className="connector-form"
        aria-label={`Connect ${entry.title}`}
        onSubmit={(event) => {
          event.preventDefault();
          const missing = current.useToken
            ? fields.find((field) => !current.values[field.key]?.trim())
            : catalogMissingField(entry, current.values);
          if (missing) {
            setProblem(entry.id, `Add the ${missing.label.toLowerCase()}.`);
            return;
          }
          void connect(entry, current.values, current.useToken);
        }}
      >
        {fields.map((field, index) => (
          <Field key={field.key} label={field.optional ? `${field.label} (optional)` : field.label} hint={field.hint}>
            <input
              ref={index === 0 ? firstField : undefined}
              className="input input-sm is-mono"
              type={field.secret ? "password" : "text"}
              autoComplete="off"
              spellCheck={false}
              value={current.values[field.key] ?? ""}
              placeholder={field.placeholder}
              onChange={(event) => {
                const value = event.target.value;
                setForm((previous) =>
                  previous ? { ...previous, values: { ...previous.values, [field.key]: value } } : previous,
                );
              }}
            />
          </Field>
        ))}
        <div className="connector-form-actions">
          {fields[0]?.createUrl ? (
            <button
              type="button"
              className="connector-link"
              onClick={() => void openExternalLink(bridge, fields[0]?.createUrl ?? "").then(setNotice)}
            >
              <Icon name="externalLink" size={12} />
              {fields[0].secret ? "Get a key" : "Open"}
            </button>
          ) : null}
          <span className="connector-spacer" />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setForm(undefined);
              setProblem(entry.id, undefined);
            }}
          >
            Cancel
          </Button>
          <Button size="sm" variant="primary" type="submit" loading={busy === entry.id}>
            Connect
          </Button>
        </div>
      </form>
    );
  };

  const renderActions = (entry: McpCatalogEntry, connector: ConnectorState) => {
    const isBusy = busy === entry.id;
    switch (connector.kind) {
      case "new":
        return (
          <>
            {entry.tokenOption ? (
              <button type="button" className="connector-link" onClick={() => start(entry, true)}>
                Use a token
              </button>
            ) : null}
            <span className="connector-spacer" />
            <Button
              size="xs"
              icon={catalogSignsIn(entry) || entry.category !== "local" ? "plus" : undefined}
              loading={isBusy}
              aria-label={`${catalogSignsIn(entry) || entry.category !== "local" ? "Connect" : "Add"} ${entry.title}`}
              onClick={() => start(entry)}
            >
              {catalogSignsIn(entry) || entry.category !== "local" ? "Connect" : "Add"}
            </Button>
          </>
        );
      case "pending":
        return null;
      case "off":
        return (
          <>
            <span className="connector-status">Turned off</span>
            <span className="connector-spacer" />
            <Button size="xs" loading={isBusy} onClick={() => void turnOn(entry, connector.server)}>
              Turn on
            </Button>
          </>
        );
      case "expired":
        return (
          <>
            <span className="connector-status is-warning">
              <Icon name="alert" size={12} />
              Sign-in expired
            </span>
            <span className="connector-spacer" />
            <Button
              size="xs"
              variant="ghost"
              disabled={isBusy}
              onClick={() => void disconnect(entry, connector.server)}
            >
              Remove
            </Button>
            <Button
              size="xs"
              variant="primary"
              loading={isBusy}
              aria-label={`Sign in again to ${entry.title}`}
              onClick={() => void run(entry.id, () => signIn(connector.server.name))}
            >
              Sign in again
            </Button>
          </>
        );
      case "signed-out":
        return (
          <>
            <span className="connector-status">Not signed in</span>
            <span className="connector-spacer" />
            <Button
              size="xs"
              variant="ghost"
              disabled={isBusy}
              onClick={() => void disconnect(entry, connector.server)}
            >
              Remove
            </Button>
            <Button
              size="xs"
              variant="primary"
              loading={isBusy}
              aria-label={`Sign in to ${entry.title}`}
              onClick={() => void run(entry.id, () => signIn(connector.server.name))}
            >
              Sign in
            </Button>
          </>
        );
      case "connected": {
        const word = entry.category === "local" ? "Remove" : "Disconnect";
        return (
          <>
            <span className="connector-status is-done">
              <Icon name="check" size={12} />
              {connector.detail}
            </span>
            <span className="connector-spacer" />
            {confirm === entry.id ? (
              <>
                <Button
                  size="xs"
                  variant="ghost"
                  className="is-danger"
                  loading={isBusy}
                  onClick={() => void disconnect(entry, connector.server)}
                >
                  {word}
                </Button>
                <Button size="xs" variant="ghost" onClick={() => setConfirm(undefined)}>
                  Keep
                </Button>
              </>
            ) : (
              <Button
                size="xs"
                variant="ghost"
                aria-label={`${word} ${entry.title}`}
                onClick={() => setConfirm(entry.id)}
              >
                {word}
              </Button>
            )}
          </>
        );
      }
    }
  };

  /** The browser sign-in in progress, inside the card that started it. */
  const renderSignIn = (entry: McpCatalogEntry, server: McpServerConfig, signIn: PendingSignIn) => (
    <div className="connector-signin">
      <span className="connector-signin-mark" aria-hidden="true">
        <span className="spinner" />
      </span>
      <div className="connector-signin-copy" role="status">
        <p className="connector-signin-title">Waiting for you to sign in to {entry.title}</p>
        <p className="connector-signin-detail">
          {signIn.code
            ? `Enter this code on the ${entry.title} page in your browser. It is already copied.`
            : `Finish on the ${entry.title} page that opened in your browser. ZLI connects as soon as you are done.`}
        </p>
        {signIn.code ? (
          <p className="connector-code">
            <strong className="is-mono">{signIn.code}</strong>
          </p>
        ) : null}
      </div>
      <div className="connector-signin-actions">
        <Button size="sm" variant="ghost" onClick={() => cancelSignIn(server.name)}>
          Cancel
        </Button>
        <Button size="sm" icon="externalLink" onClick={() => void reopenSignIn(server.name).then(setNotice)}>
          Open again
        </Button>
      </div>
    </div>
  );

  /** Tool count, Test, and projects, once a connector is connected. */
  const renderHealth = (entry: McpCatalogEntry, server: McpServerConfig) => {
    const health = healthFor(result, server.name);
    const isTesting = Boolean(testing[server.name]);
    return (
      <div className="connector-card-meta">
        <McpStatusDot status={serverStatus(result, server.name)} />
        <span className="connector-health">
          {health ? (health.ok ? toolCountText(health.toolCount) : "Not working") : "Not tested"}
        </span>
        <button
          type="button"
          className="connector-link"
          aria-label={`Test ${entry.title}`}
          disabled={isTesting}
          onClick={() => void runTest(entry.id, server.name)}
        >
          {isTesting ? <span className="spinner" aria-hidden="true" /> : null}
          {isTesting ? "Testing" : "Test"}
        </button>
        <span className="connector-spacer" />
        <McpProjectsButton
          title={entry.title}
          selected={server.projects ?? []}
          disabled={busy === entry.id}
          onChange={(projects) => void setProjects(entry, server, projects)}
        />
      </div>
    );
  };

  return (
    <>
      {visible.length === 0 ? <p className="settings-empty">No connectors match.</p> : null}
      {groups.map((group) => (
        <section className="connector-group" key={group.id} aria-label={group.label || "Connectors"}>
          {group.label ? <h4 className="mcp-subhead">{group.label}</h4> : null}
          <ul className="connector-grid">
            {group.entries.map((entry) => {
              const connector = states.get(entry.id) ?? { kind: "new" };
              const editing = form?.id === entry.id && connector.kind === "new" ? form : undefined;
              const problem = problems[entry.id];
              return (
                <li
                  key={entry.id}
                  className={`connector-card${editing || connector.kind === "pending" ? " is-open" : ""}`}
                  data-entry={entry.id}
                  data-state={connector.kind}
                >
                  <div className="connector-card-head">
                    <ConnectorLogo id={entry.id} title={entry.title} size={36} />
                    <span className="connector-card-titles">
                      <strong>{entry.title}</strong>
                      <span className="connector-card-cost">{entry.costLabel}</span>
                    </span>
                    <button
                      type="button"
                      className="connector-home"
                      aria-label={`About ${entry.title}`}
                      data-tooltip="Open the docs"
                      onClick={() => void openExternalLink(bridge, entry.homepage).then(setNotice)}
                    >
                      <Icon name="externalLink" size={12} />
                    </button>
                  </div>
                  <p className="connector-card-desc">{entry.description}</p>
                  {entry.needs ? <p className="connector-card-needs">{entry.needs}</p> : null}
                  {connector.kind === "connected" && !editing ? renderHealth(entry, connector.server) : null}
                  {connector.kind === "pending" ? (
                    renderSignIn(entry, connector.server, connector.signIn)
                  ) : editing ? (
                    renderForm(entry, editing)
                  ) : (
                    <div className="connector-card-foot">{renderActions(entry, connector)}</div>
                  )}
                  {problem ? (
                    <p className="inline-error" role="alert">
                      <Icon name="alert" size={13} />
                      <span>
                        {problem}
                        {entry.tokenOption && connector.kind !== "connected" && !editing ? (
                          <>
                            {" "}
                            <button type="button" className="connector-link" onClick={() => start(entry, true)}>
                              Use a token instead
                            </button>
                          </>
                        ) : null}
                      </span>
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {notice ? <p className="settings-footnote">{notice}</p> : null}
    </>
  );
}
