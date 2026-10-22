import { AgentToolAccess, type McpServerConfig } from "@zli-v2/contracts";
import { useRef, useState } from "react";

import { Button, IconButton } from "../ui/Button.js";
import { Field, Select } from "../ui/Field.js";
import { Icon } from "../ui/Icon.js";
import {
  AGENT_ACCESS_LABELS,
  applyDraft,
  commandLine,
  draftFromServer,
  EMPTY_DRAFT,
  type McpDraft,
  settingsProblems,
  useMcpServers,
} from "./mcpServers.js";
import { SectionHeader } from "./SectionHeader.js";

type Editing = { index?: number; draft: McpDraft };

const SETTINGS_AGENTS = "Cursor, Droid, Gemini, Kimi Code, and Qwen Code";

export function McpServersSection() {
  const { state, reload, save, setAgentAccess } = useMcpServers();
  const [editing, setEditing] = useState<Editing>();
  const [problem, setProblem] = useState<string>();
  const [saveError, setSaveError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string>();
  const nameRef = useRef<HTMLInputElement>(null);

  const header = (
    <SectionHeader title="MCP servers">
      Every agent ZLI starts gets these servers, in terminals and in chats. Changes reach agents started after you save.
    </SectionHeader>
  );

  if (state.status === "loading") {
    return (
      <>
        {header}
        <p className="settings-empty">Loading MCP servers.</p>
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

  const { servers, userSettings, agentAccess, problem: storeProblem } = state.result;
  const problems = settingsProblems(userSettings.outcomes);

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
    const server = index === undefined ? undefined : servers[index];
    setEditing(
      index !== undefined && server ? { index, draft: draftFromServer(server) } : { draft: { ...EMPTY_DRAFT } },
    );
    requestAnimationFrame(() => nameRef.current?.focus());
  };

  const submit = async () => {
    if (!editing) return;
    const applied = applyDraft(servers, editing.draft, editing.index);
    if ("problem" in applied) {
      setProblem(applied.problem);
      return;
    }
    setProblem(undefined);
    if (await persist(applied.servers)) setEditing(undefined);
  };

  const setDraft = (patch: Partial<McpDraft>) =>
    setEditing((current) => (current ? { ...current, draft: { ...current.draft, ...patch } } : current));

  return (
    <>
      {header}
      {storeProblem ? (
        <p className="inline-error" role="alert">
          <Icon name="alert" size={13} />
          {storeProblem} Saving starts a new list.
        </p>
      ) : null}
      <h3 className="mcp-subhead">Built into ZLI</h3>
      <ul className="mcp-rows">
        <li className="mcp-row">
          <span className="mcp-row-copy">
            <strong>zli</strong>
            <span className="mcp-row-detail">
              Lets agents see and read the other agents in their project, and start or message them if allowed. Also the
              zli command in terminals.
            </span>
          </span>
          <Select
            className="input-sm"
            aria-label="What agents may do with other agents"
            value={agentAccess}
            disabled={saving}
            onChange={(event) => {
              const access = AgentToolAccess.parse(event.target.value);
              void run(() => setAgentAccess(access));
            }}
          >
            {AgentToolAccess.options.map((access) => (
              <option key={access} value={access}>
                {AGENT_ACCESS_LABELS[access]}
              </option>
            ))}
          </Select>
        </li>
        <li className="mcp-row">
          <span className="mcp-row-copy">
            <strong>zli-browser</strong>
            <span className="mcp-row-detail">
              Lets agents open and test pages in the Browser panel. Always on, and the zli-browser command in terminals.
            </span>
          </span>
        </li>
      </ul>
      <h3 className="mcp-subhead">Added by you</h3>
      {servers.length === 0 && !editing ? (
        <p className="settings-empty">
          No servers yet. Add one here instead of in each agent's own settings, and every agent can use it.
        </p>
      ) : null}
      {servers.length > 0 ? (
        <ul className="mcp-rows">
          {servers.map((server, index) => (
            <li className={`mcp-row${server.enabled ? "" : " is-off"}`} key={server.name}>
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
              <span className="mcp-row-copy">
                <strong>{server.name}</strong>
                <span className="mcp-row-command" title={commandLine(server)}>
                  {commandLine(server)}
                </span>
              </span>
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
            </li>
          ))}
        </ul>
      ) : null}
      {saveError && !editing ? (
        <p className="inline-error" role="alert">
          <Icon name="alert" size={13} />
          {saveError}
        </p>
      ) : null}
      {editing ? (
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
      ) : (
        <div className="settings-actions">
          <Button size="sm" icon="plus" disabled={saving} onClick={() => startEdit()}>
            Add server
          </Button>
        </div>
      )}
      <p className="settings-section-note">
        {userSettings.enabled
          ? `${SETTINGS_AGENTS} read servers only from their own settings files, so ZLI also writes enabled servers there and removes the ones it added.`
          : `${SETTINGS_AGENTS} read servers only from their own settings files, and this ZLI is set not to change those files.`}
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
