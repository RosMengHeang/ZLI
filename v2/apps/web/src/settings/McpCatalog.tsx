import {
  catalogEntryAdded,
  catalogMissingField,
  catalogServer,
  MCP_CATALOG,
  type McpCatalogCost,
  type McpCatalogEntry,
  type McpServerConfig,
} from "@zli-v2/contracts";
import { useMemo, useRef, useState } from "react";

import { openExternalLink } from "../review/links.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";
import { Badge, type BadgeTone } from "../ui/Badge.js";
import { Button } from "../ui/Button.js";
import { Field } from "../ui/Field.js";
import { Icon } from "../ui/Icon.js";
import { isWindows } from "./mcpServers.js";

const COST_TONES: Record<McpCatalogCost, BadgeTone> = { free: "success", account: "info", paid: "warning" };

/** Whether an entry matches the search box: every word appears in its name, title, or description. */
export function catalogMatches(entry: McpCatalogEntry, query: string): boolean {
  const haystack = `${entry.id} ${entry.title} ${entry.description}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/u)
    .filter((word) => word.length > 0)
    .every((word) => haystack.includes(word));
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Popular servers with one-click Add. Entries that need a value ask for it in place before saving. */
export function McpCatalog({
  servers,
  saving,
  saveError,
  onAdd,
  onClose,
}: {
  servers: readonly McpServerConfig[];
  saving: boolean;
  saveError: string | undefined;
  /** Resolves with a problem to show, or undefined once saved. */
  onAdd(server: McpServerConfig): Promise<string | undefined>;
  onClose(): void;
}) {
  const { bridge } = useRuntime();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string>();
  const [values, setValues] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<{ id: string; message: string }>();
  const [linkNotice, setLinkNotice] = useState<string>();
  const firstField = useRef<HTMLInputElement>(null);
  const entries = useMemo(() => MCP_CATALOG.filter((entry) => catalogMatches(entry, query)), [query]);

  const add = async (entry: McpCatalogEntry, filled: Record<string, string>) => {
    const missing = catalogMissingField(entry, filled);
    if (missing) {
      setProblem({ id: entry.id, message: `Add the ${missing.label.toLowerCase()}.` });
      return;
    }
    setProblem(undefined);
    const failure = await onAdd(catalogServer(entry, filled, { windows: isWindows() }));
    if (failure) {
      setProblem({ id: entry.id, message: failure });
      return;
    }
    setOpen(undefined);
    setValues({});
  };

  const start = (entry: McpCatalogEntry) => {
    setProblem(undefined);
    if (entry.fields.length === 0) {
      void add(entry, {});
      return;
    }
    setOpen(entry.id);
    setValues({});
    requestAnimationFrame(() => firstField.current?.focus());
  };

  return (
    <section className="mcp-catalog" aria-label="MCP server catalog">
      <div className="mcp-catalog-head">
        <input
          className="input input-sm"
          type="search"
          value={query}
          placeholder="Search servers"
          aria-label="Search servers"
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button size="sm" onClick={onClose}>
          Done
        </Button>
      </div>
      {entries.length === 0 ? <p className="settings-empty">No servers match.</p> : null}
      <ul className="mcp-rows mcp-catalog-list">
        {entries.map((entry) => {
          const added = catalogEntryAdded(entry, servers);
          const editing = open === entry.id && !added;
          const entryProblem = problem?.id === entry.id ? problem.message : undefined;
          return (
            <li className="mcp-catalog-item" key={entry.id} data-entry={entry.id}>
              <div className="mcp-row">
                <span className="mcp-row-copy">
                  <span className="mcp-catalog-title">
                    <strong>{entry.title}</strong>
                    <Badge tone={COST_TONES[entry.cost]}>{entry.costLabel}</Badge>
                  </span>
                  <span className="mcp-row-detail">{entry.description}</span>
                  {entry.needs ? <span className="mcp-catalog-needs">{entry.needs}</span> : null}
                  <button
                    type="button"
                    className="mcp-catalog-link"
                    onClick={() => void openExternalLink(bridge, entry.homepage).then(setLinkNotice)}
                  >
                    {hostOf(entry.homepage)}
                  </button>
                </span>
                {added ? (
                  <Badge tone="quiet">Added</Badge>
                ) : editing ? null : (
                  <Button
                    size="xs"
                    icon="plus"
                    disabled={saving}
                    aria-label={`Add ${entry.title}`}
                    onClick={() => start(entry)}
                  >
                    Add
                  </Button>
                )}
              </div>
              {editing ? (
                <form
                  className="mcp-catalog-form"
                  aria-label={`Add ${entry.title}`}
                  onSubmit={(event) => {
                    event.preventDefault();
                    void add(entry, values);
                  }}
                >
                  {entry.fields.map((field, index) => (
                    <Field
                      key={field.key}
                      label={field.optional ? `${field.label} (optional)` : field.label}
                      hint={field.hint}
                    >
                      <input
                        ref={index === 0 ? firstField : undefined}
                        className="input input-sm is-mono"
                        type={field.secret ? "password" : "text"}
                        autoComplete="off"
                        spellCheck={false}
                        value={values[field.key] ?? ""}
                        placeholder={field.placeholder}
                        onChange={(event) => {
                          const value = event.target.value;
                          setValues((current) => ({ ...current, [field.key]: value }));
                        }}
                      />
                    </Field>
                  ))}
                  {entryProblem ? (
                    <p className="inline-error" role="alert">
                      <Icon name="alert" size={13} />
                      {entryProblem}
                    </p>
                  ) : null}
                  <div className="mcp-editor-actions">
                    <Button
                      size="sm"
                      onClick={() => {
                        setOpen(undefined);
                        setProblem(undefined);
                      }}
                    >
                      Cancel
                    </Button>
                    <Button size="sm" variant="primary" type="submit" loading={saving}>
                      Add server
                    </Button>
                  </div>
                </form>
              ) : entryProblem ? (
                <p className="inline-error" role="alert">
                  <Icon name="alert" size={13} />
                  {entryProblem}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
      {saveError && !problem ? (
        <p className="inline-error" role="alert">
          <Icon name="alert" size={13} />
          {saveError}
        </p>
      ) : null}
      {linkNotice ? <p className="settings-footnote">{linkNotice}</p> : null}
    </section>
  );
}
