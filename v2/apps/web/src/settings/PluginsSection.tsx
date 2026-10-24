import type { PluginInstallPreview, PluginSummary } from "@zli-v2/contracts";
import { useRef, useState } from "react";

import {
  componentSummary,
  configurePlugin,
  formatLabel,
  installPlugins,
  previewPluginInstall,
  removePlugin,
  setPluginEnabled,
  updatePlugin,
  usePlugins,
} from "../plugins/plugins.js";
import { Badge } from "../ui/Badge.js";
import { Button, IconButton } from "../ui/Button.js";
import { Field } from "../ui/Field.js";
import { Icon } from "../ui/Icon.js";
import { SectionHeader } from "./SectionHeader.js";
import { formatBytes } from "./skills.js";

type Installing = { source: string; preview?: PluginInstallPreview; selected: string[] };
type Configuring = { name: string; values: Record<string, string> };

export function PluginsSection() {
  const { state, reload, dispatch, apply } = usePlugins();
  const [installing, setInstalling] = useState<Installing>();
  const [configuring, setConfiguring] = useState<Configuring>();
  const [confirmRemove, setConfirmRemove] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const sourceRef = useRef<HTMLInputElement>(null);

  const header = (
    <SectionHeader title="Plugins">
      Bundles of skills, MCP servers, prompts, and actions. ZLI reads Claude Code and Codex plugins and hands their
      parts to every agent.
    </SectionHeader>
  );

  if (state.status === "loading") {
    return (
      <>
        {header}
        <p className="loading-line">
          <span className="spinner" aria-hidden="true" />
          Loading plugins
        </p>
      </>
    );
  }
  if (state.status === "error") {
    return (
      <>
        {header}
        <p className="inline-error" role="alert">
          <Icon name="alert" size={13} />
          {state.message}
        </p>
        <div className="settings-actions">
          <Button size="sm" onClick={reload}>
            Try again
          </Button>
        </div>
      </>
    );
  }

  const result = state.result;

  const run = async (key: string, work: () => Promise<unknown>): Promise<boolean> => {
    setBusy(key);
    setError(undefined);
    try {
      await work();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return false;
    } finally {
      setBusy(undefined);
    }
  };

  const closeForms = () => {
    setInstalling(undefined);
    setConfiguring(undefined);
    setConfirmRemove(undefined);
    setError(undefined);
  };

  const startInstall = () => {
    closeForms();
    setInstalling({ source: "", selected: [] });
    requestAnimationFrame(() => sourceRef.current?.focus());
  };

  const lookUp = () =>
    run("install", async () => {
      if (!installing) return;
      const preview = await previewPluginInstall(dispatch, installing.source);
      const selected = preview.candidates.filter((candidate) => !candidate.problem).map((candidate) => candidate.name);
      setInstalling((current) => (current ? { ...current, preview, selected } : current));
    });

  const install = async () => {
    if (!installing?.preview) return;
    const { source, selected } = installing;
    const done = await run("install", () => apply((send) => installPlugins(send, source, selected)));
    if (!done) return;
    setInstalling(undefined);
    const needsSettings = installing.preview.candidates.find(
      (candidate) => selected.includes(candidate.name) && candidate.config.some((option) => option.required),
    );
    if (needsSettings) setConfiguring({ name: needsSettings.name, values: {} });
  };

  const saveSettings = async () => {
    if (!configuring) return;
    const done = await run(`configure:${configuring.name}`, () =>
      apply((send) => configurePlugin(send, configuring.name, configuring.values)),
    );
    if (done) setConfiguring(undefined);
  };

  const pluginRow = (plugin: PluginSummary) => {
    const summary = componentSummary(plugin.components);
    const rowBusy = busy !== undefined;
    return (
      <li className={`mcp-row plugin-row${plugin.enabled ? "" : " is-off"}`} key={plugin.name}>
        <input
          className="switch"
          type="checkbox"
          role="switch"
          checked={plugin.enabled}
          aria-checked={plugin.enabled}
          aria-label={`Turn on ${plugin.displayName}`}
          disabled={rowBusy}
          onChange={(event) =>
            void run(`enable:${plugin.name}`, () =>
              apply((send) => setPluginEnabled(send, plugin.name, event.target.checked)),
            )
          }
        />
        <span className="mcp-row-copy">
          <span className="skill-row-title">
            <strong>{plugin.displayName}</strong>
            <Badge>{formatLabel[plugin.format]}</Badge>
            {plugin.version ? <Badge tone="info">v{plugin.version}</Badge> : null}
          </span>
          <span className="mcp-row-detail">{plugin.description || "No description."}</span>
          {summary ? <span className="mcp-row-detail">{summary}</span> : null}
          {plugin.components.ignored.length > 0 ? (
            <span className="mcp-row-detail">
              Left out, since only Claude Code or Codex runs them: {plugin.components.ignored.join(", ")}.
            </span>
          ) : null}
          {plugin.enabled
            ? plugin.problems.map((line) => (
                <span className="skill-row-problem" key={line}>
                  {line}
                </span>
              ))
            : null}
          <span className="mcp-row-command" title={plugin.source}>
            {plugin.source}
          </span>
        </span>
        {confirmRemove === plugin.name ? (
          <>
            <Button
              variant="ghost"
              size="xs"
              className="is-danger"
              loading={busy === `remove:${plugin.name}`}
              onClick={async () => {
                if (await run(`remove:${plugin.name}`, () => apply((send) => removePlugin(send, plugin.name)))) {
                  setConfirmRemove(undefined);
                  if (configuring?.name === plugin.name) setConfiguring(undefined);
                }
              }}
            >
              Remove
            </Button>
            <Button variant="ghost" size="xs" onClick={() => setConfirmRemove(undefined)}>
              Keep
            </Button>
          </>
        ) : (
          <>
            {plugin.config.length > 0 ? (
              <IconButton
                label={`Settings for ${plugin.displayName}`}
                icon="settings"
                size="xs"
                iconSize={12}
                disabled={rowBusy}
                onClick={() => {
                  closeForms();
                  setConfiguring({ name: plugin.name, values: {} });
                }}
              />
            ) : null}
            <IconButton
              label={`Update ${plugin.displayName}`}
              tooltip="Download it again from its source"
              icon="reload"
              size="xs"
              iconSize={12}
              disabled={rowBusy}
              onClick={() => void run(`update:${plugin.name}`, () => apply((send) => updatePlugin(send, plugin.name)))}
            />
            <IconButton
              label={`Remove ${plugin.displayName}`}
              icon="trash"
              size="xs"
              iconSize={12}
              disabled={rowBusy}
              onClick={() => setConfirmRemove(plugin.name)}
            />
          </>
        )}
      </li>
    );
  };

  const configured = configuring ? result.plugins.find((plugin) => plugin.name === configuring.name) : undefined;

  return (
    <>
      {header}
      {result.problem ? (
        <p className="inline-error" role="alert">
          <Icon name="alert" size={13} />
          {result.problem} Installing a plugin starts the list over.
        </p>
      ) : null}

      {result.plugins.length > 0 ? (
        <ul className="mcp-rows">{result.plugins.map(pluginRow)}</ul>
      ) : (
        <p className="settings-empty">No plugins yet. Install one from GitHub or from a folder on this computer.</p>
      )}

      {error && !installing && !configuring ? (
        <p className="inline-error" role="alert">
          <Icon name="alert" size={13} />
          {error}
        </p>
      ) : null}

      {configuring && configured ? (
        <form
          className="mcp-editor"
          aria-label={`Settings for ${configured.displayName}`}
          onSubmit={(event) => {
            event.preventDefault();
            void saveSettings();
          }}
        >
          <p className="field-label">Settings for {configured.displayName}</p>
          {configured.config.map((option) => {
            const saved = configured.configured.includes(option.key);
            const placeholder = option.sensitive && saved ? "Saved. Leave blank to keep it." : (option.default ?? "");
            return (
              <Field
                key={option.key}
                label={`${option.title}${option.required ? "" : " (optional)"}`}
                hint={option.description}
              >
                <input
                  className="input input-sm"
                  type={option.sensitive ? "password" : option.type === "number" ? "number" : "text"}
                  autoComplete="off"
                  spellCheck={false}
                  value={configuring.values[option.key] ?? ""}
                  placeholder={placeholder}
                  onChange={(event) => {
                    const value = event.target.value;
                    setConfiguring((current) =>
                      current ? { ...current, values: { ...current.values, [option.key]: value } } : current,
                    );
                  }}
                />
              </Field>
            );
          })}
          <p className="settings-footnote">
            Values stay on this computer in a file only you can read. Blank fields keep what is saved.
          </p>
          {error ? (
            <p className="inline-error" role="alert">
              <Icon name="alert" size={13} />
              {error}
            </p>
          ) : null}
          <div className="mcp-editor-actions">
            <Button size="sm" onClick={closeForms}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" type="submit" loading={busy === `configure:${configuring.name}`}>
              Save settings
            </Button>
          </div>
        </form>
      ) : installing ? (
        <form
          className="mcp-editor"
          aria-label="Install a plugin"
          onSubmit={(event) => {
            event.preventDefault();
            void lookUp();
          }}
        >
          <Field
            label="Source"
            hint="A GitHub link or owner/repo, such as anthropics/claude-plugins-official, or the full path of a folder on this computer."
          >
            <input
              ref={sourceRef}
              className="input input-sm is-mono"
              value={installing.source}
              spellCheck={false}
              placeholder="owner/repo"
              onChange={(event) => setInstalling({ source: event.target.value, selected: [] })}
            />
          </Field>
          {installing.preview ? (
            <InstallChoices
              preview={installing.preview}
              selected={installing.selected}
              onChange={(selected) => setInstalling((current) => (current ? { ...current, selected } : current))}
            />
          ) : null}
          {error ? (
            <p className="inline-error" role="alert">
              <Icon name="alert" size={13} />
              {error}
            </p>
          ) : null}
          <div className="mcp-editor-actions">
            <Button size="sm" onClick={closeForms}>
              Cancel
            </Button>
            {installing.preview ? (
              <Button
                size="sm"
                variant="primary"
                loading={busy === "install"}
                disabled={installing.selected.length === 0}
                onClick={() => void install()}
              >
                {installing.selected.length === 1
                  ? "Install 1 plugin"
                  : `Install ${installing.selected.length} plugins`}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="primary"
                type="submit"
                loading={busy === "install"}
                disabled={!installing.source.trim()}
              >
                Look up
              </Button>
            )}
          </div>
        </form>
      ) : (
        <div className="settings-actions skill-actions">
          <Button size="sm" icon="download" disabled={busy !== undefined} onClick={startInstall}>
            Install plugin
          </Button>
        </div>
      )}

      <p className="settings-footnote">
        Plugin skills are copied with your own skills, and plugin MCP servers start with your own servers. Your own
        skills and servers win when a name is taken. Prompts appear when you type / in a chat, and actions in the
        command palette. Plugins are kept in {result.pluginsPath}.
      </p>
    </>
  );
}

function InstallChoices({
  preview,
  selected,
  onChange,
}: {
  preview: PluginInstallPreview;
  selected: readonly string[];
  onChange(selected: string[]): void;
}) {
  return (
    <>
      <fieldset className="skill-candidates">
        <legend className="field-label">
          {preview.marketplace ? `${preview.marketplace}, in ${preview.label}` : `Found in ${preview.label}`}
        </legend>
        {preview.candidates.length === 0 ? (
          <p className="settings-empty">This catalog lists no plugins stored in the same repository.</p>
        ) : null}
        {preview.candidates.map((candidate) => {
          const checked = selected.includes(candidate.name);
          const summary = componentSummary(candidate.components);
          return (
            <label className={`skill-candidate${candidate.problem ? " is-off" : ""}`} key={candidate.path}>
              <input
                type="checkbox"
                checked={checked}
                disabled={candidate.problem !== undefined}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...selected, candidate.name]
                      : selected.filter((name) => name !== candidate.name),
                  )
                }
              />
              <span className="mcp-row-copy">
                <span className="skill-row-title">
                  <strong>{candidate.displayName}</strong>
                  <Badge>{formatLabel[candidate.format]}</Badge>
                </span>
                <span className="mcp-row-detail">{candidate.description || "No description."}</span>
                {summary ? <span className="mcp-row-detail">{summary}</span> : null}
                {candidate.components.mcpServers.length > 0 ? (
                  <span className="mcp-row-detail">MCP servers: {candidate.components.mcpServers.join(", ")}</span>
                ) : null}
                {candidate.components.actions.map((action) => (
                  <span className="mcp-row-command" key={action.name} title={action.command}>
                    {action.name}: {action.command}
                  </span>
                ))}
                {candidate.components.ignored.length > 0 ? (
                  <span className="mcp-row-detail">Left out: {candidate.components.ignored.join(", ")}.</span>
                ) : null}
                <span className="mcp-row-command">
                  {candidate.path}, {candidate.files === 1 ? "1 file" : `${candidate.files} files`},{" "}
                  {formatBytes(candidate.bytes)}
                </span>
                {candidate.problem ? <span className="skill-row-problem">{candidate.problem}</span> : null}
                {!candidate.problem && candidate.exists ? (
                  <span className="skill-row-problem">Replaces the installed plugin with this name.</span>
                ) : null}
              </span>
            </label>
          );
        })}
      </fieldset>
      {preview.elsewhere.length > 0 ? (
        <div className="plugin-elsewhere">
          <p className="field-label">Listed here but stored elsewhere. Install them from their own source:</p>
          <ul>
            {preview.elsewhere.map((entry) => (
              <li key={entry.name}>
                <strong>{entry.name}</strong> <span className="mcp-row-command">{entry.source}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="settings-footnote">
        Plugins run code on this computer through their MCP servers and actions. Install only ones you trust.
      </p>
    </>
  );
}
