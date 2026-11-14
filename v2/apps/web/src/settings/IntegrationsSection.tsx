import { MCP_CATALOG } from "@zli-v2/contracts";
import { type KeyboardEvent, useId, useRef, useState } from "react";

import { ConnectorsSection } from "./ConnectorsSection.js";
import { McpServersSection } from "./McpServersSection.js";
import { PluginsSection } from "./PluginsSection.js";
import { SettingsGroup, SettingsPageHeader, TextLink } from "./SettingsLayout.js";
import "./connectors.css";

export type IntegrationsView = "browse" | "installed" | "custom";
type Kind = "all" | "connectors" | "plugins";

const views: { id: IntegrationsView; label: string }[] = [
  { id: "browse", label: "Browse" },
  { id: "installed", label: "Installed" },
  { id: "custom", label: "Custom" },
];

const kinds: { id: Kind; label: string }[] = [
  { id: "all", label: "All" },
  { id: "connectors", label: "Connectors" },
  { id: "plugins", label: "Plugins" },
];

/** Connectors, MCP servers, and plugins in one place: find them, manage what is set up, or bring your own. */
export function IntegrationsSection({
  initialView = "browse",
  focusConnector,
  onAgentMessages,
}: {
  initialView?: IntegrationsView | undefined;
  /** A catalog id whose card Browse opens on, by searching for it. */
  focusConnector?: string | undefined;
  /** Opens the Settings section that holds the zli tool's settings. */
  onAgentMessages?: (() => void) | undefined;
}) {
  const [view, setView] = useState<IntegrationsView>(initialView);
  const [query, setQuery] = useState(() => MCP_CATALOG.find((entry) => entry.id === focusConnector)?.title ?? "");
  const [kind, setKind] = useState<Kind>("all");
  const ids = useId();
  const tabRefs = useRef<Partial<Record<IntegrationsView, HTMLButtonElement | null>>>({});

  const select = (next: IntegrationsView, focus = false) => {
    setView(next);
    if (focus) tabRefs.current[next]?.focus();
  };

  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = views.findIndex((entry) => entry.id === view);
    const target =
      event.key === "ArrowRight"
        ? views[(index + 1) % views.length]
        : event.key === "ArrowLeft"
          ? views[(index - 1 + views.length) % views.length]
          : event.key === "Home"
            ? views[0]
            : event.key === "End"
              ? views[views.length - 1]
              : undefined;
    if (!target) return;
    event.preventDefault();
    select(target.id, true);
  };

  const toBrowse = () => select("browse");
  const toInstalled = () => select("installed");
  const toCustom = () => select("custom");

  return (
    <>
      <SettingsPageHeader title="Integrations">
        Connect services, add MCP servers, and install plugins. Every agent ZLI starts can use them, in terminals and
        chats, from the next time it starts.
      </SettingsPageHeader>
      <div className="integrations-tabs" role="tablist" aria-label="Integrations" onKeyDown={onTabKey}>
        {views.map((entry) => (
          <button
            key={entry.id}
            ref={(element) => {
              tabRefs.current[entry.id] = element;
            }}
            className="integrations-tab"
            type="button"
            role="tab"
            id={`${ids}-${entry.id}`}
            aria-selected={view === entry.id}
            aria-controls={`${ids}-panel`}
            tabIndex={view === entry.id ? 0 : -1}
            onClick={() => select(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <div className="integrations-panel" role="tabpanel" id={`${ids}-panel`} aria-labelledby={`${ids}-${view}`}>
        {view === "browse" ? (
          <>
            <div className="connector-toolbar">
              <input
                className="input input-sm"
                type="search"
                value={query}
                placeholder="Search connectors and plugins"
                aria-label="Search integrations"
                spellCheck={false}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <div className="connector-filters" role="toolbar" aria-label="Show">
              {kinds.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="connector-chip"
                  aria-pressed={kind === item.id}
                  onClick={() => setKind(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            {kind === "plugins" ? null : (
              <SettingsGroup
                title="Connectors"
                description="Services and local tools you set up once. Sign-ins stay on this computer, in ZLI's data folder."
                bare
              >
                <ConnectorsSection query={query} />
              </SettingsGroup>
            )}
            {kind === "connectors" ? null : (
              <SettingsGroup
                title="Plugins"
                description="Claude Code and Codex bundles of skills, prompts, and MCP servers. ZLI hands their parts to every agent."
                bare
              >
                <PluginsSection view="browse" query={query} onInstalled={toInstalled} />
              </SettingsGroup>
            )}
            <p className="settings-footnote">
              Not listed? Add any MCP server by its address or command, or install a plugin from GitHub, in{" "}
              <TextLink onClick={toCustom}>Custom</TextLink>.
            </p>
          </>
        ) : null}
        {view === "installed" ? (
          <>
            <McpServersSection
              view="installed"
              onBrowse={toBrowse}
              onCustom={toCustom}
              onAgentMessages={onAgentMessages}
            />
            <PluginsSection view="installed" onBrowse={toBrowse} onCustom={toCustom} />
          </>
        ) : null}
        {view === "custom" ? (
          <>
            <SettingsGroup
              title="MCP server"
              description="Add a server by its web address or the command that starts it, or copy the servers set up in Claude, Cursor, VS Code, or Windsurf."
              bare
            >
              <McpServersSection view="custom" onInstalled={toInstalled} />
            </SettingsGroup>
            <SettingsGroup
              title="Plugin"
              description="Install one from a GitHub repository or a folder on this computer, or save your own skills and MCP servers as a plugin to share."
              bare
            >
              <PluginsSection view="custom" onInstalled={toInstalled} />
            </SettingsGroup>
          </>
        ) : null}
      </div>
    </>
  );
}
