import {
  catalogEntryServer,
  catalogMissingField,
  catalogServer,
  catalogSignsIn,
  isHttpServer,
  MCP_CATALOG,
  MCP_CATALOG_CATEGORIES,
  type McpCatalogCategory,
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
import {
  applyServer,
  isWindows,
  type PendingSignIn,
  SIGN_IN_CANCELED,
  signedInText,
  signInFor,
  useMcpServers,
} from "./mcpServers.js";
import { SectionHeader } from "./SectionHeader.js";
import "./connectors.css";

type Filter = "all" | "connected" | McpCatalogCategory;

/** Where a connector stands for the person, which decides the card's button. */
export type ConnectorState =
  | { kind: "new" }
  | { kind: "pending"; server: McpServerConfig; signIn: PendingSignIn }
  | { kind: "off"; server: McpServerConfig }
  | { kind: "signed-out"; server: McpServerConfig }
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
    const text = signedInText(signInFor(result, server.name));
    return text ? { kind: "connected", server, detail: text } : { kind: "signed-out", server };
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

export function ConnectorsSection({ onOpenMcpServers }: { onOpenMcpServers?(): void }) {
  const { bridge } = useRuntime();
  const { state, reload, save, signIn, cancelSignIn, reopenSignIn, signOut, pending } = useMcpServers();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [form, setForm] = useState<Form>();
  const [busy, setBusy] = useState<string>();
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const firstField = useRef<HTMLInputElement>(null);

  const header = (
    <SectionHeader title="Connectors">
      Connect the services you work with. Sign in once here and every agent ZLI starts can use them, in terminals and
      chats.
    </SectionHeader>
  );

  const result = state.status === "ready" ? state.result : undefined;
  const states = useMemo(() => {
    const map = new Map<string, ConnectorState>();
    if (result) for (const entry of MCP_CATALOG) map.set(entry.id, connectorState(entry, result, pending));
    return map;
  }, [result, pending]);

  if (state.status === "loading") {
    return (
      <>
        {header}
        <p className="loading-line">
          <span className="spinner" aria-hidden="true" />
          Loading connectors
        </p>
      </>
    );
  }
  if (state.status === "error" || !result) {
    return (
      <>
        {header}
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

  const visible = MCP_CATALOG.filter(
    (entry) =>
      connectorMatches(entry, query) &&
      (filter === "all" ||
        (filter === "connected" ? states.get(entry.id)?.kind === "connected" : entry.category === filter)),
  );
  const grouped = filter === "all" && !query.trim();
  const groups = grouped
    ? MCP_CATALOG_CATEGORIES.map((category) => ({
        ...category,
        entries: visible.filter((entry) => entry.category === category.id),
      })).filter((group) => group.entries.length > 0)
    : [{ id: "results", label: "", entries: visible }];
  const connectedCount = [...states.values()].filter((entry) => entry.kind === "connected").length;

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
              variant={catalogSignsIn(entry) ? "primary" : "secondary"}
              loading={isBusy}
              aria-label={`${catalogSignsIn(entry) || entry.category !== "local" ? "Connect" : "Add"} ${entry.title}`}
              onClick={() => start(entry)}
            >
              {catalogSignsIn(entry) || entry.category !== "local" ? "Connect" : "Add"}
            </Button>
          </>
        );
      case "pending":
        return (
          <>
            <span className="connector-status is-pending">
              <span className="spinner" aria-hidden="true" />
              {connector.signIn.code ? "Enter the code in your browser" : "Finish in your browser"}
            </span>
            <span className="connector-spacer" />
            <button
              type="button"
              className="connector-link"
              onClick={() => void reopenSignIn(connector.server.name).then(setNotice)}
            >
              Open again
            </button>
            <Button size="xs" variant="ghost" onClick={() => cancelSignIn(connector.server.name)}>
              Cancel
            </Button>
          </>
        );
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
            <span className="connector-status is-connected">
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

  return (
    <>
      {header}
      <div className="connector-toolbar">
        <input
          className="input input-sm"
          type="search"
          value={query}
          placeholder="Search connectors"
          aria-label="Search connectors"
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className="connector-filters" role="toolbar" aria-label="Show">
        {(
          [
            { id: "all", label: "All" },
            { id: "connected", label: connectedCount > 0 ? `Connected (${connectedCount})` : "Connected" },
            ...MCP_CATALOG_CATEGORIES,
          ] as { id: Filter; label: string }[]
        ).map((item) => (
          <button
            key={item.id}
            type="button"
            className="connector-chip"
            aria-pressed={filter === item.id}
            onClick={() => setFilter(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      {visible.length === 0 ? (
        <p className="settings-empty">
          {filter === "connected" && !query.trim() ? "Nothing connected yet." : "No connectors match."}
        </p>
      ) : null}
      {groups.map((group) => (
        <section className="connector-group" key={group.id} aria-label={group.label || "Connectors"}>
          {group.label ? <h3 className="mcp-subhead">{group.label}</h3> : null}
          <ul className="connector-grid">
            {group.entries.map((entry) => {
              const connector = states.get(entry.id) ?? { kind: "new" };
              const editing = form?.id === entry.id && connector.kind === "new" ? form : undefined;
              const problem = problems[entry.id];
              return (
                <li
                  key={entry.id}
                  className={`connector-card${editing ? " is-open" : ""}`}
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
                  {connector.kind === "pending" && connector.signIn.code ? (
                    <p className="connector-code">
                      Code <strong className="is-mono">{connector.signIn.code}</strong>, copied for you
                    </p>
                  ) : null}
                  {editing ? (
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
      <p className="settings-footnote">
        Not listed here? Any MCP server can be added by its address or command in{" "}
        {onOpenMcpServers ? (
          <button type="button" className="connector-link" onClick={onOpenMcpServers}>
            MCP servers
          </button>
        ) : (
          "MCP servers"
        )}
        . Logins stay on this computer, in ZLI's data folder.
      </p>
      {notice ? <p className="settings-footnote">{notice}</p> : null}
    </>
  );
}
