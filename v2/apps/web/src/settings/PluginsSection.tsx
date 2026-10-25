import type { PluginInstallPreview, PluginOrigin, PluginSummary } from "@zli-v2/contracts";
import { useEffect, useRef, useState } from "react";

import { OriginBadge } from "../plugins/OriginBadge.js";
import {
  checkPluginUpdates,
  componentSummary,
  configurePlugin,
  formatLabel,
  installPlugins,
  originForSource,
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
import { PluginExportForm } from "./PluginExportForm.js";
import { PluginGallery } from "./PluginGallery.js";
import { SectionHeader } from "./SectionHeader.js";
import { formatBytes } from "./skills.js";
import "../plugins/plugins.css";

type Installing = {
  source: string;
  /** The list it was picked from. Unset when the person typed the source. */
  origin?: PluginOrigin;
  preview?: PluginInstallPreview;
  selected: string[];
};
type Configuring = { name: string; values: Record<string, string> };

export function PluginsSection() {
  const { state, reload, dispatch, apply } = usePlugins();
  const [installing, setInstalling] = useState<Installing>();
  const [configuring, setConfiguring] = useState<Configuring>();
  const [confirmRemove, setConfirmRemove] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [exporting, setExporting] = useState(false);
  const [saved, setSaved] = useState<string>();
  const [checkProblem, setCheckProblem] = useState<string>();
  const sourceRef = useRef<HTMLInputElement>(null);
  const installRef = useRef<HTMLFormElement>(null);
  const checked = useRef(false);

  // Checks for updates once per visit, without holding up the list.
  useEffect(() => {
    if (state.status !== "ready" || checked.current) return;
    checked.current = true;
    const before = state.result.problem;
    void apply(async (send) => {
      const list = await checkPluginUpdates(send);
      if (!list.problem || list.problem === before) return list;
      setCheckProblem(list.problem);
      const { problem: _problem, ...rest } = list;
      return before ? { ...rest, problem: before } : rest;
    }).catch(() => undefined);
  }, [state, apply]);

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
    setExporting(false);
    setSaved(undefined);
    setError(undefined);
  };

  const startInstall = () => {
    closeForms();
    setInstalling({ source: "", selected: [] });
    requestAnimationFrame(() => sourceRef.current?.focus());
  };

  const lookUp = (source: string) =>
    run("install", async () => {
      const preview = await previewPluginInstall(dispatch, source);
      const selected = preview.candidates.filter((candidate) => !candidate.problem).map((candidate) => candidate.name);
      setInstalling((current) => (current?.source === source ? { ...current, preview, selected } : current));
    });

  const installFromGallery = (source: string, origin: PluginOrigin) => {
    closeForms();
    setInstalling({ source, origin, selected: [] });
    requestAnimationFrame(() => installRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" }));
    void lookUp(source);
  };

  const install = async () => {
    if (!installing?.preview) return;
    const { source, selected, origin } = installing;
    const done = await run("install", () => apply((send) => installPlugins(send, source, selected, origin)));
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
    const update = () => void run(`update:${plugin.name}`, () => apply((send) => updatePlugin(send, plugin.name)));
    const updating = busy === `update:${plugin.name}`;
    const updateControl = plugin.updateAvailable ? (
      <Button
        size="xs"
        variant="primary"
        loading={updating}
        disabled={rowBusy}
        aria-label={`Update ${plugin.displayName}`}
        onClick={update}
      >
        Update
      </Button>
    ) : plugin.pinned ? null : plugin.sourceKind === "local" ? (
      <Button
        size="xs"
        variant="ghost"
        loading={updating}
        disabled={rowBusy}
        aria-label={`Reload ${plugin.displayName} from its folder`}
        onClick={update}
      >
        Reload from folder
      </Button>
    ) : plugin.updateAvailable === undefined ? (
      <IconButton
        label={`Update ${plugin.displayName}`}
        tooltip="Download it again from its source"
        icon="reload"
        size="xs"
        iconSize={12}
        disabled={rowBusy}
        onClick={update}
      />
    ) : null;
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
            <OriginBadge origin={plugin.origin} />
            {plugin.updateAvailable ? <Badge tone="info">Update available</Badge> : null}
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
            {updateControl}
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

      <h3 className="mcp-subhead">Your plugins</h3>
      {result.plugins.length > 0 ? (
        <ul className="mcp-rows">{result.plugins.map(pluginRow)}</ul>
      ) : (
        <p className="settings-empty">
          No plugins yet. Pick one below, or install one from GitHub or a folder on this computer.
        </p>
      )}
      {checkProblem ? <p className="settings-footnote">{checkProblem}</p> : null}

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
          ref={installRef}
          className="mcp-editor"
          aria-label="Install a plugin"
          onSubmit={(event) => {
            event.preventDefault();
            void lookUp(installing.source);
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
              origin={originForSource(installing.source, installing.origin)}
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
      ) : exporting ? (
        <PluginExportForm
          onCancel={closeForms}
          onSaved={(done) => {
            setExporting(false);
            setSaved(done.folder);
          }}
        />
      ) : (
        <>
          {saved ? (
            <p className="plugin-export-saved" role="status">
              <Icon name="check" size={13} />
              Saved to {saved}.
            </p>
          ) : null}
          <div className="settings-actions skill-actions">
            <Button size="sm" icon="download" disabled={busy !== undefined} onClick={startInstall}>
              Install plugin
            </Button>
            <Button
              size="sm"
              icon="upload"
              disabled={busy !== undefined}
              onClick={() => {
                closeForms();
                setExporting(true);
              }}
            >
              Share my setup
            </Button>
          </div>
        </>
      )}

      <PluginGallery
        installed={new Set(result.plugins.map((plugin) => plugin.name))}
        disabled={busy !== undefined}
        loadingSource={busy === "install" && !installing?.preview ? installing?.source : undefined}
        onInstall={installFromGallery}
      />

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
  origin,
  selected,
  onChange,
}: {
  preview: PluginInstallPreview;
  origin: PluginOrigin;
  selected: readonly string[];
  onChange(selected: string[]): void;
}) {
  const runsCode = preview.candidates.some(
    (candidate) => candidate.components.actions.length > 0 || candidate.components.mcpServers.length > 0,
  );
  return (
    <>
      <fieldset className="skill-candidates">
        <legend className="field-label plugin-legend">
          {preview.marketplace ? `${preview.marketplace}, in ${preview.label}` : `Found in ${preview.label}`}
          <OriginBadge origin={origin} />
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
      {origin === "other" && runsCode ? (
        <p className="plugin-warning" role="note">
          <Icon name="alert" size={13} /> This plugin can run commands on your computer. Install it only if you trust
          where it came from.
        </p>
      ) : null}
      <p className="settings-footnote">
        Plugins run code on this computer through their MCP servers and actions. Install only ones you trust.
      </p>
    </>
  );
}
