import {
  PLUGIN_CATALOG,
  PLUGIN_CATALOG_CATEGORIES,
  type PluginCatalogEntry,
  type PluginDirectoryEntry,
  type PluginDirectoryResult,
  type PluginOrigin,
} from "@zli-v2/contracts";
import { type ReactNode, useState } from "react";

import { pluginDirectory } from "../plugins/plugins.js";
import { openExternalLink } from "../review/links.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";
import { Button } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { ConnectorLogo, hasConnectorLogo } from "./connectorLogos.js";
import "./connectors.css";
import "../plugins/plugins.css";

const PAGE_SIZE = 30;

type DirectoryState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; result: PluginDirectoryResult }
  | { status: "error"; message: string };

/** Whether every word of the search appears in the plugin's name, title, description, publisher, or category. */
export function pluginMatches(
  entry: {
    name: string;
    title: string;
    description: string;
    publisher?: string | undefined;
    category?: string | undefined;
  },
  query: string,
): boolean {
  const category = PLUGIN_CATALOG_CATEGORIES.find((item) => item.id === entry.category)?.label ?? entry.category ?? "";
  const haystack =
    `${entry.name} ${entry.title} ${entry.description} ${entry.publisher ?? ""} ${category}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/u)
    .filter((word) => word.length > 0)
    .every((word) => haystack.includes(word));
}

const catalogMatches = (entry: PluginCatalogEntry, query: string) => pluginMatches({ ...entry, name: entry.id }, query);

/** Directory plugins from Anthropic are Claude Code plugins, so they share Claude's mark when ZLI has no logo for them. */
function directoryLogo(entry: PluginDirectoryEntry): string {
  return hasConnectorLogo(entry.name) || entry.publisher !== "Anthropic" ? entry.name : "claude";
}

/** ZLI's own plugin picks, and Anthropic's directory on request, filtered by the shared search. */
export function PluginGallery({
  query,
  installed,
  disabled,
  loadingSource,
  onInstall,
}: {
  query: string;
  /** Names of installed plugins. */
  installed: ReadonlySet<string>;
  disabled: boolean;
  /** The source being looked up, whose Install button shows a spinner. */
  loadingSource: string | undefined;
  onInstall(source: string, origin: PluginOrigin): void;
}) {
  const { bridge, dispatch } = useRuntime();
  const [directory, setDirectory] = useState<DirectoryState>({ status: "idle" });
  // Paging starts over whenever the search changes.
  const [page, setPage] = useState({ query, shown: PAGE_SIZE });
  const shown = page.query === query ? page.shown : PAGE_SIZE;
  const [notice, setNotice] = useState<string>();

  const loadDirectory = () => {
    setDirectory({ status: "loading" });
    pluginDirectory(dispatch).then(
      (result) => setDirectory({ status: "ready", result }),
      (error: unknown) =>
        setDirectory({ status: "error", message: error instanceof Error ? error.message : String(error) }),
    );
  };

  const openLink = (url: string) => void openExternalLink(bridge, url).then(setNotice);

  const visible = PLUGIN_CATALOG.filter((entry) => catalogMatches(entry, query));
  const groups = query.trim()
    ? [{ id: "results", label: "", entries: visible }]
    : PLUGIN_CATALOG_CATEGORIES.map((category) => ({
        ...category,
        entries: visible.filter((entry) => entry.category === category.id),
      })).filter((group) => group.entries.length > 0);

  const installButton = (title: string, source: string, origin: PluginOrigin) => (
    <>
      <span className="connector-spacer" />
      <Button
        size="xs"
        loading={loadingSource === source}
        disabled={disabled}
        aria-label={`Install ${title}`}
        onClick={() => onInstall(source, origin)}
      >
        Install
      </Button>
    </>
  );

  const installedStatus = (
    <span className="connector-status is-done">
      <Icon name="check" size={12} />
      Installed
    </span>
  );

  const card = (
    key: string,
    logoId: string,
    title: string,
    byline: string | undefined,
    description: string,
    homepage: string | undefined,
    foot: ReactNode,
    isInstalled: boolean,
  ) => (
    <li key={key} className="connector-card" data-entry={key} data-state={isInstalled ? "connected" : "new"}>
      <div className="connector-card-head">
        <ConnectorLogo id={logoId} title={title} size={36} />
        <span className="connector-card-titles">
          <strong>{title}</strong>
          {byline ? <span className="plugin-card-publisher">{byline}</span> : null}
        </span>
        {homepage ? (
          <button
            type="button"
            className="connector-home"
            aria-label={`About ${title}`}
            data-tooltip="Open its page"
            onClick={() => openLink(homepage)}
          >
            <Icon name="externalLink" size={12} />
          </button>
        ) : null}
      </div>
      <p className="connector-card-desc">{description || "No description."}</p>
      <div className="connector-card-foot">{foot}</div>
    </li>
  );

  const directoryCard = (entry: PluginDirectoryEntry) => {
    const isInstalled = installed.has(entry.name);
    const foot = entry.unsupported ? (
      <p className="plugin-card-unsupported">{entry.unsupported}</p>
    ) : isInstalled ? (
      installedStatus
    ) : entry.source ? (
      installButton(entry.title, entry.source, "anthropic-directory")
    ) : null;
    return card(
      `directory:${entry.name}`,
      directoryLogo(entry),
      entry.title,
      entry.publisher ?? entry.category,
      entry.description,
      entry.homepage,
      foot,
      isInstalled,
    );
  };

  const renderDirectory = () => {
    switch (directory.status) {
      case "idle":
        return (
          <div className="settings-actions">
            <Button size="sm" icon="search" onClick={loadDirectory}>
              Search Anthropic's plugin directory
            </Button>
          </div>
        );
      case "loading":
        return (
          <p className="loading-line">
            <span className="spinner" aria-hidden="true" />
            Loading Anthropic's plugin directory
          </p>
        );
      case "error":
        return (
          <>
            <p className="inline-error" role="alert">
              <Icon name="alert" size={13} />
              {directory.message}
            </p>
            <div className="settings-actions">
              <Button size="sm" onClick={loadDirectory}>
                Try again
              </Button>
            </div>
          </>
        );
      case "ready": {
        const { result } = directory;
        if (result.entries.length === 0) {
          return (
            <>
              <p
                className={result.problem ? "inline-error" : "settings-empty"}
                role={result.problem ? "alert" : undefined}
              >
                {result.problem ? <Icon name="alert" size={13} /> : null}
                {result.problem ?? "The directory lists no plugins right now."}
              </p>
              <div className="settings-actions">
                <Button size="sm" onClick={loadDirectory}>
                  Try again
                </Button>
              </div>
            </>
          );
        }
        const matches = result.entries.filter((entry) => pluginMatches(entry, query));
        return (
          <section className="plugin-directory" aria-label="Anthropic's plugin directory">
            <h4 className="mcp-subhead">Anthropic's plugin directory</h4>
            <p className="plugin-directory-note">
              {query.trim()
                ? `${matches.length} of ${result.entries.length} plugins match.`
                : `${result.entries.length} plugins.`}{" "}
              ZLI has not checked these.
            </p>
            {matches.length === 0 ? <p className="settings-empty">No directory plugins match.</p> : null}
            <ul className="connector-grid">{matches.slice(0, shown).map(directoryCard)}</ul>
            {matches.length > shown ? (
              <div className="settings-actions">
                <Button size="sm" onClick={() => setPage({ query, shown: shown + PAGE_SIZE })}>
                  Show more
                </Button>
              </div>
            ) : null}
            {result.problem ? <p className="settings-footnote">{result.problem}</p> : null}
          </section>
        );
      }
    }
  };

  return (
    <div className="plugin-gallery">
      {visible.length === 0 ? <p className="settings-empty">No plugins match.</p> : null}
      {groups.map((group) => (
        <section className="connector-group" key={group.id} aria-label={group.label || "Plugins"}>
          {group.label ? <h4 className="mcp-subhead">{group.label}</h4> : null}
          <ul className="connector-grid">
            {group.entries.map((entry) =>
              card(
                entry.id,
                entry.logoId ?? entry.id,
                entry.title,
                entry.publisher,
                entry.description,
                entry.homepage,
                installed.has(entry.id) ? installedStatus : installButton(entry.title, entry.source, "zli-catalog"),
                installed.has(entry.id),
              ),
            )}
          </ul>
        </section>
      ))}
      {renderDirectory()}
      {notice ? <p className="settings-footnote">{notice}</p> : null}
    </div>
  );
}
