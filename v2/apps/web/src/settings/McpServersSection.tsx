import { isHttpServer, MCP_CATALOG, type McpServerConfig } from "@zli-v2/contracts";
import { Fragment, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { useMobileSettings } from "../mobile/useMobileSettings.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";
import { Button, IconButton } from "../ui/Button.js";
import { Field, Select } from "../ui/Field.js";
import { Icon } from "../ui/Icon.js";
import { ZliLogo } from "../ui/ZliLogo.js";
import { ConnectorLogo } from "./connectorLogos.js";
import { McpImportPanel } from "./McpImportPanel.js";
import { McpProjectsField, useKnownProjects } from "./McpProjectPicker.js";
import { McpStatusDot } from "./McpStatusDot.js";
import { McpToolsPanel } from "./McpToolsPanel.js";
import {
  AGENT_ACCESS_LABELS,
  AGENT_SCOPE_LABELS,
  applyDraft,
  catalogEntryForUrl,
  draftFromServer,
  EMPTY_DRAFT,
  type McpDraft,
  type McpTransport,
  pluginSignIns as pluginSignInsOf,
  projectCountText,
  projectNames,
  SIGN_IN_CANCELED,
  serverStatus,
  serverSummary,
  settingsProblems,
  signedInText,
  signInFor,
  TRANSPORT_LABELS,
  useMcpServers,
  withDisabledTools,
} from "./mcpServers.js";
import { TextLink } from "./SectionHeader.js";

type Editing = { index?: number; draft: McpDraft };

const SETTINGS_AGENTS = "Cursor, Droid, Gemini, Kimi Code, and Qwen Code";

/** The catalog entry a saved server came from, by name or address, for its logo and title. */
export function serverLogoId(server: McpServerConfig): string {
  const key = server.name.toLowerCase();
  const entry =
    MCP_CATALOG.find((candidate) => candidate.id === key) ??
    (isHttpServer(server) ? catalogEntryForUrl(server.url) : undefined);
  return entry?.id ?? server.name;
}

export type McpServersView = "installed" | "custom";

/** MCP servers on one Integrations tab: the saved and built-in servers on Installed, adding and importing on Custom. */
export function McpServersSection({
  view,
  onBrowse,
  onCustom,
  onInstalled,
  onAgentMessages,
}: {
  view: McpServersView;
  onBrowse?(): void;
  onCustom?(): void;
  onInstalled?(): void;
  onAgentMessages?: (() => void) | undefined;
}) {
  const { state, reload, save, signIn, cancelSignIn, signOut, pending, test, tests, testing } = useMcpServers();
  const knownProjects = useKnownProjects();
  const [signInProblems, setSignInProblems] = useState<Record<string, string>>({});
  const [openTools, setOpenTools] = useState<ReadonlySet<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState<string>();
  const [added, setAdded] = useState<string>();
  const [editing, setEditing] = useState<Editing>();
  const [problem, setProblem] = useState<string>();
  const [saveError, setSaveError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string>();
  const nameRef = useRef<HTMLInputElement>(null);

  if (state.status === "loading") {
    return (
      <p className="loading-line">
        <span className="spinner" aria-hidden="true" />
        Loading MCP servers
      </p>
    );
  }
  if (state.status === "error") {
    return (
      <>
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

  const { servers, userSettings, agentAccess, agentScope, problem: storeProblem } = state.result;
  const zliStatus =
    agentAccess === "off"
      ? "Off."
      : `${AGENT_ACCESS_LABELS[agentAccess]}, ${AGENT_SCOPE_LABELS[agentScope].toLowerCase()}.`;
  const problems = settingsProblems(userSettings.outcomes);
  const pluginSignIns = pluginSignInsOf(state.result);
  const result = state.result;

  const runSignIn = async (name: string, work: () => Promise<unknown>) => {
    setSignInProblems((current) => ({ ...current, [name]: "" }));
    try {
      await work();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== SIGN_IN_CANCELED) setSignInProblems((current) => ({ ...current, [name]: message }));
    }
  };

  /** Sign in, Cancel, or Sign out for a server that signs in through ZLI. */
  const signInControls = (name: string) => {
    const entry = signInFor(state.result, name);
    if (!entry) return null;
    if (pending[name]) {
      return (
        <span className="mcp-row-actions">
          <span className="mcp-row-signin">
            {pending[name]?.code ? `Enter code ${pending[name]?.code} in your browser` : "Finish in your browser"}
          </span>
          <Button size="xs" variant="ghost" onClick={() => cancelSignIn(name)}>
            Cancel
          </Button>
        </span>
      );
    }
    const text = signedInText(entry);
    if (text) {
      return (
        <span className="mcp-row-actions">
          <span className="mcp-row-signin is-signed-in">{text}</span>
          <Button size="xs" variant="ghost" onClick={() => void runSignIn(name, () => signOut(name))}>
            Sign out
          </Button>
        </span>
      );
    }
    if (entry.expired) {
      return (
        <span className="mcp-row-actions">
          <span className="mcp-row-signin is-expired">Sign-in expired</span>
          <Button size="xs" variant="primary" onClick={() => void runSignIn(name, () => signIn(name))}>
            Sign in again
          </Button>
        </span>
      );
    }
    return (
      <Button size="xs" variant="primary" onClick={() => void runSignIn(name, () => signIn(name))}>
        Sign in
      </Button>
    );
  };

  const setToolsOpen = (name: string, open: boolean) =>
    setOpenTools((current) => {
      const next = new Set(current);
      if (open) next.add(name);
      else next.delete(name);
      return next;
    });

  const runTest = async (name: string) => {
    setSignInProblems((current) => ({ ...current, [name]: "" }));
    try {
      await test(name);
      setToolsOpen(name, true);
    } catch (error) {
      setSignInProblems((current) => ({
        ...current,
        [name]: error instanceof Error ? error.message : String(error),
      }));
    }
  };

  const testButton = (name: string) => (
    <Button
      size="xs"
      variant="ghost"
      loading={Boolean(testing[name])}
      aria-label={`Test ${name}`}
      tooltip={testing[name] ? "Starting the server. Local servers can take a while the first time." : undefined}
      onClick={() => void runTest(name)}
    >
      Test
    </Button>
  );

  /** The title line: name, status dot, and a chip when the server is limited to some projects. */
  const rowTitle = (name: string, projects?: readonly string[]) => (
    <span className="mcp-row-title">
      <strong>{name}</strong>
      <McpStatusDot status={serverStatus(result, name)} />
      {projects && projects.length > 0 ? (
        <span className="mcp-chip" data-tooltip={projectNames(projects, knownProjects).join(", ")}>
          {projectCountText(projects.length)}
        </span>
      ) : null}
    </span>
  );

  const signInProblem = (name: string) =>
    signInProblems[name] ? (
      <p className="inline-error" role="alert">
        <Icon name="alert" size={13} />
        {signInProblems[name]}
      </p>
    ) : null;

  const run = async (work: () => Promise<unknown>): Promise<boolean> => {
    setSaving(true);
    setSaveError(undefined);
    try {
      await work();
      return true;
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const persist = (next: McpServerConfig[]) => run(() => save(next));

  const startEdit = (index?: number) => {
    setConfirmDelete(undefined);
    setProblem(undefined);
    setImporting(false);
    setAdded(undefined);
    setImported(undefined);
    const server = index === undefined ? undefined : servers[index];
    flushSync(() =>
      setEditing(
        index !== undefined && server ? { index, draft: draftFromServer(server) } : { draft: { ...EMPTY_DRAFT } },
      ),
    );
    nameRef.current?.focus();
  };

  const submit = async () => {
    if (!editing) return;
    const applied = applyDraft(servers, editing.draft, editing.index);
    if ("problem" in applied) {
      setProblem(applied.problem);
      return;
    }
    setProblem(undefined);
    if (!(await persist(applied.servers))) return;
    if (editing.index === undefined) setAdded(editing.draft.name.trim());
    setEditing(undefined);
  };

  const saveDisabledTools = (name: string, disabledTools: string[]) =>
    persist(servers.map((entry) => (entry.name === name ? withDisabledTools(entry, disabledTools) : entry)));

  const setDraft = (patch: Partial<McpDraft>) =>
    setEditing((current) => (current ? { ...current, draft: { ...current.draft, ...patch } } : current));

  const editorForm = editing ? (
    <form
      className="mcp-editor"
      aria-label={editing.index === undefined ? "New MCP server" : "Edit MCP server"}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Field label="Name" hint="Agents show it next to the server's tools.">
        <input
          ref={nameRef}
          className="input input-sm"
          value={editing.draft.name}
          maxLength={64}
          spellCheck={false}
          placeholder="github"
          onChange={(event) => setDraft({ name: event.target.value })}
        />
      </Field>
      <div className="field">
        <span className="field-label">Type</span>
        <Select<McpTransport>
          className="input-sm"
          label="Type"
          value={editing.draft.transport}
          options={(["stdio", "http"] as const).map((value) => ({ value, label: TRANSPORT_LABELS[value] }))}
          onChange={(transport) => setDraft({ transport })}
        />
      </div>
      {editing.draft.transport === "http" ? (
        <>
          <Field label="URL" hint="The server's streamable HTTP address. Plain http:// works only for localhost.">
            <input
              className="input input-sm is-mono"
              inputMode="url"
              value={editing.draft.url}
              spellCheck={false}
              placeholder="https://mcp.example.com/mcp"
              onChange={(event) => setDraft({ url: event.target.value })}
            />
          </Field>
          <Field
            label="Headers"
            hint="One Name: value per line, such as Authorization: Bearer and your token. Values stay on this computer, in ZLI's data folder and the agent config files it writes."
          >
            <textarea
              className="textarea is-mono"
              rows={2}
              value={editing.draft.headers}
              spellCheck={false}
              onChange={(event) => setDraft({ headers: event.target.value })}
            />
          </Field>
          <label className="check-field mcp-oauth">
            <input
              type="checkbox"
              checked={editing.draft.oauth}
              onChange={(event) => setDraft({ oauth: event.target.checked })}
            />
            <span className="choice-copy">
              <span className="choice-title">Sign in with browser (OAuth)</span>
              <span className="choice-detail">
                For servers that ask you to sign in, such as Linear, Notion, and Sentry. After saving, use Sign in next
                to the server. ZLI keeps the login and gives every agent a fresh token.
              </span>
            </span>
          </label>
        </>
      ) : (
        <>
          <Field
            label="Command"
            hint="On Windows, start npx servers through cmd: command cmd, then /c and npx as the first arguments."
          >
            <input
              className="input input-sm is-mono"
              value={editing.draft.command}
              spellCheck={false}
              placeholder="npx"
              onChange={(event) => setDraft({ command: event.target.value })}
            />
          </Field>
          <Field label="Arguments" hint="One per line.">
            <textarea
              className="textarea is-mono"
              rows={3}
              value={editing.draft.args}
              spellCheck={false}
              onChange={(event) => setDraft({ args: event.target.value })}
            />
          </Field>
          <Field
            label="Environment"
            hint="One NAME=value per line. Values stay on this computer, in ZLI's data folder and the agent config files it writes."
          >
            <textarea
              className="textarea is-mono"
              rows={2}
              value={editing.draft.env}
              spellCheck={false}
              onChange={(event) => setDraft({ env: event.target.value })}
            />
          </Field>
        </>
      )}
      <McpProjectsField
        limit={editing.draft.limitProjects}
        selected={editing.draft.projects}
        onChange={(patch) => setDraft(patch)}
      />
      {problem || saveError ? (
        <p className="inline-error" role="alert">
          <Icon name="alert" size={13} />
          {problem ?? saveError}
        </p>
      ) : null}
      <div className="mcp-editor-actions">
        <Button
          size="sm"
          onClick={() => {
            setEditing(undefined);
            setProblem(undefined);
            setSaveError(undefined);
          }}
        >
          Cancel
        </Button>
        <Button size="sm" variant="primary" type="submit" loading={saving}>
          {editing.index === undefined ? "Add server" : "Save changes"}
        </Button>
      </div>
    </form>
  ) : null;

  const storeAlert = storeProblem ? (
    <p className="inline-error" role="alert">
      <Icon name="alert" size={13} />
      {storeProblem} Saving starts a new list.
    </p>
  ) : null;

  if (view === "custom") {
    return (
      <>
        {storeAlert}
        {editing && editing.index === undefined ? (
          editorForm
        ) : importing ? (
          <McpImportPanel
            servers={servers}
            onSave={save}
            onDone={(message) => {
              setImporting(false);
              setImported(message);
            }}
          />
        ) : (
          <div className="settings-actions mcp-actions">
            <Button size="sm" icon="plus" disabled={saving} onClick={() => startEdit()}>
              Add server
            </Button>
            <Button
              size="sm"
              icon="download"
              disabled={saving}
              onClick={() => {
                setImported(undefined);
                setAdded(undefined);
                setImporting(true);
              }}
            >
              Import from other apps
            </Button>
          </div>
        )}
        {added && !editing ? (
          <p className="settings-done" role="status">
            <Icon name="check" size={13} />
            <span>
              Added {added}. It is listed in <TextLink onClick={onInstalled}>Installed</TextLink>.
            </span>
          </p>
        ) : null}
        {imported && !importing ? (
          <p className="settings-footnote" role="status">
            {imported}
          </p>
        ) : null}
      </>
    );
  }

  return (
    <>
      {storeAlert}
      <h3 className="mcp-subhead">Built into ZLI</h3>
      <ul className="mcp-rows">
        <li className="mcp-row">
          <ZliLogo size={28} className="mcp-row-logo" />
          <span className="mcp-row-copy">
            <strong>zli</strong>
            <span className="mcp-row-detail">
              Lets agents list, read, start, and message other agents. Also available as the zli command in terminals.{" "}
              {zliStatus} Change it in <TextLink onClick={onAgentMessages}>Agent messages</TextLink>.
            </span>
          </span>
        </li>
        <li className="mcp-row">
          <ZliLogo size={28} className="mcp-row-logo" />
          <span className="mcp-row-copy">
            <strong>zli-browser</strong>
            <span className="mcp-row-detail">
              Lets agents open and test pages in the Browser panel. Always on, and available as the zli-browser command
              in terminals.
            </span>
          </span>
        </li>
        <ZliMobileRow />
      </ul>
      <h3 className="mcp-subhead">Your MCP servers</h3>
      {servers.length === 0 ? (
        <p className="settings-empty">
          No servers yet. Connect one in <TextLink onClick={onBrowse}>Browse</TextLink>, or add your own in{" "}
          <TextLink onClick={onCustom}>Custom</TextLink>.
        </p>
      ) : null}
      {servers.length > 0 ? (
        <ul className="mcp-rows">
          {servers.map((server, index) => (
            <Fragment key={server.name}>
              <li className={`mcp-row${server.enabled ? "" : " is-off"}`}>
                <ConnectorLogo id={serverLogoId(server)} title={server.name} size={28} />
                <span className="mcp-row-copy">
                  {rowTitle(server.name, server.projects)}
                  <span className="mcp-row-command" title={serverSummary(server)}>
                    {serverSummary(server)}
                  </span>
                </span>
                {confirmDelete === server.name ? null : signInControls(server.name)}
                {confirmDelete === server.name ? null : testButton(server.name)}
                {confirmDelete === server.name ? (
                  <>
                    <Button
                      variant="ghost"
                      size="xs"
                      className="is-danger"
                      disabled={saving}
                      onClick={async () => {
                        if (await persist(servers.filter((_, at) => at !== index))) {
                          setConfirmDelete(undefined);
                          if (editing?.index === index) setEditing(undefined);
                        }
                      }}
                    >
                      Remove
                    </Button>
                    <Button variant="ghost" size="xs" onClick={() => setConfirmDelete(undefined)}>
                      Keep
                    </Button>
                  </>
                ) : (
                  <>
                    <IconButton
                      label={`Edit ${server.name}`}
                      icon="pencil"
                      size="xs"
                      iconSize={12}
                      disabled={saving}
                      onClick={() => startEdit(index)}
                    />
                    <IconButton
                      label={`Remove ${server.name}`}
                      icon="trash"
                      size="xs"
                      iconSize={12}
                      disabled={saving}
                      onClick={() => setConfirmDelete(server.name)}
                    />
                  </>
                )}
                <input
                  className="switch"
                  type="checkbox"
                  role="switch"
                  checked={server.enabled}
                  aria-checked={server.enabled}
                  aria-label={`Give agents ${server.name}`}
                  disabled={saving}
                  onChange={(event) =>
                    void persist(
                      servers.map((entry, at) => (at === index ? { ...entry, enabled: event.target.checked } : entry)),
                    )
                  }
                />
              </li>
              {openTools.has(server.name) && tests[server.name] ? (
                <li className="mcp-row-tools">
                  <McpToolsPanel
                    test={tests[server.name] as NonNullable<(typeof tests)[string]>}
                    disabledTools={server.disabledTools ?? []}
                    saving={saving}
                    onChange={(disabledTools) => saveDisabledTools(server.name, disabledTools)}
                    onClose={() => setToolsOpen(server.name, false)}
                  />
                </li>
              ) : null}
            </Fragment>
          ))}
        </ul>
      ) : null}
      {servers.map((server) => (
        <div key={server.name}>{signInProblem(server.name)}</div>
      ))}
      {pluginSignIns.length > 0 ? (
        <>
          <h3 className="mcp-subhead">Servers from plugins</h3>
          <ul className="mcp-rows">
            {pluginSignIns.map((entry) => (
              <Fragment key={entry.name}>
                <li className="mcp-row">
                  <ConnectorLogo id={catalogEntryForUrl(entry.url)?.id ?? entry.name} title={entry.name} size={28} />
                  <span className="mcp-row-copy">
                    {rowTitle(entry.name)}
                    <span className="mcp-row-command" title={entry.url}>
                      {entry.url}
                    </span>
                  </span>
                  {signInControls(entry.name)}
                  {testButton(entry.name)}
                </li>
                {openTools.has(entry.name) && tests[entry.name] ? (
                  <li className="mcp-row-tools">
                    <McpToolsPanel
                      test={tests[entry.name] as NonNullable<(typeof tests)[string]>}
                      onClose={() => setToolsOpen(entry.name, false)}
                    />
                  </li>
                ) : null}
              </Fragment>
            ))}
          </ul>
          {pluginSignIns.map((entry) => (
            <div key={entry.name}>{signInProblem(entry.name)}</div>
          ))}
        </>
      ) : null}
      {saveError && !editing ? (
        <p className="inline-error" role="alert">
          <Icon name="alert" size={13} />
          {saveError}
        </p>
      ) : null}
      {editorForm}
      <p className="settings-footnote">
        {userSettings.enabled
          ? `${SETTINGS_AGENTS} only read servers from their own settings files, so ZLI writes enabled servers there and removes the ones it added.`
          : `${SETTINGS_AGENTS} only read servers from their own settings files, and ZLI is set to leave those files alone.`}
      </p>
      {problems.length > 0 ? (
        <ul className="mcp-settings-problems">
          {problems.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/** Shown only in the desktop app, where the device tools exist. */
function ZliMobileRow() {
  const { bridge } = useRuntime();
  const mobile = bridge?.mobile;
  const { settings, error, setAgentTools } = useMobileSettings(mobile);
  if (!mobile) return null;
  const on = settings?.agentTools ?? false;
  return (
    <li className={`mcp-row${settings && !on ? " is-off" : ""}`}>
      <ZliLogo size={28} className="mcp-row-logo" />
      <span className="mcp-row-copy">
        <strong>zli-mobile</strong>
        <span className="mcp-row-detail" role={error ? "alert" : undefined}>
          {error ??
            "Lets agents boot Android emulators and iOS simulators, install and open apps, tap, type, and read logs, all shown in the Mobile panel. Also available as the zli-mobile command in terminals."}
        </span>
      </span>
      <input
        className="switch"
        type="checkbox"
        role="switch"
        checked={on}
        aria-checked={on}
        aria-label="Give agents zli-mobile"
        disabled={!settings}
        onChange={(event) => setAgentTools(event.target.checked)}
      />
    </li>
  );
}
