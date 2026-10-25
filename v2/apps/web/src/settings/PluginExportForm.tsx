import { type PluginExportResult, skillNameProblem } from "@zli-v2/contracts";
import { useEffect, useRef, useState } from "react";

import { exportPluginFolder } from "../plugins/plugins.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";
import { Button } from "../ui/Button.js";
import { Field } from "../ui/Field.js";
import { Icon } from "../ui/Icon.js";
import { listMcpServers } from "./mcpServers.js";
import { listSkills } from "./skills.js";
import "../plugins/plugins.css";

type Choice = { name: string; detail: string };
type Lists = { status: "loading" } | { status: "ready"; skills: Choice[]; servers: Choice[]; problem?: string };

/** Writes chosen skills and MCP servers to a folder as a plugin others can install. */
export function PluginExportForm({
  onCancel,
  onSaved,
}: {
  onCancel(): void;
  onSaved(result: PluginExportResult): void;
}) {
  const { bridge, dispatch } = useRuntime();
  const [lists, setLists] = useState<Lists>({ status: "loading" });
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [folder, setFolder] = useState("");
  const [skills, setSkills] = useState<string[]>([]);
  const [servers, setServers] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const pickFolder = bridge?.dialog?.openProject;

  useEffect(() => {
    let cancelled = false;
    nameRef.current?.focus();
    void Promise.allSettled([listSkills(dispatch), listMcpServers(dispatch)]).then(([skillList, serverList]) => {
      if (cancelled) return;
      const problems = [
        ...(skillList.status === "rejected" ? ["Your skills could not be listed."] : []),
        ...(serverList.status === "rejected" ? ["Your MCP servers could not be listed."] : []),
      ];
      setLists({
        status: "ready",
        skills:
          skillList.status === "fulfilled"
            ? skillList.value.skills
                .filter((skill) => skill.scope === "user")
                .map((skill) => ({ name: skill.name, detail: skill.description }))
            : [],
        servers:
          serverList.status === "fulfilled"
            ? serverList.value.servers.map((server) => ({
                name: server.name,
                detail: server.transport === "http" ? server.url : server.command,
              }))
            : [],
        ...(problems.length > 0 ? { problem: problems.join(" ") } : {}),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [dispatch]);

  const submit = async () => {
    const trimmed = name.trim();
    const problem =
      skillNameProblem(trimmed) ??
      (skills.length + servers.length === 0 ? "Pick at least one skill or MCP server." : undefined) ??
      (folder.trim() ? undefined : "Pick a folder.");
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const result = await exportPluginFolder(dispatch, {
        folder: folder.trim(),
        name: trimmed,
        ...(description.trim() ? { description: description.trim() } : {}),
        skills,
        servers,
      });
      onSaved(result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const checklist = (
    legend: string,
    choices: readonly Choice[],
    chosen: readonly string[],
    setChosen: (next: string[]) => void,
    empty: string,
  ) => (
    <fieldset className="plugin-export-list">
      <legend className="field-label">{legend}</legend>
      {choices.length === 0 ? <p className="settings-empty">{empty}</p> : null}
      {choices.map((choice) => (
        <label className="skill-candidate" key={choice.name}>
          <input
            type="checkbox"
            checked={chosen.includes(choice.name)}
            onChange={(event) =>
              setChosen(
                event.target.checked ? [...chosen, choice.name] : chosen.filter((entry) => entry !== choice.name),
              )
            }
          />
          <span className="mcp-row-copy">
            <strong>{choice.name}</strong>
            {choice.detail ? <span className="mcp-row-detail">{choice.detail}</span> : null}
          </span>
        </label>
      ))}
    </fieldset>
  );

  return (
    <form
      className="mcp-editor"
      aria-label="Share my setup"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <p className="field-label">Share my setup as a plugin</p>
      <Field label="Plugin name" hint="Lowercase letters, digits, and hyphens, such as my-setup.">
        <input
          ref={nameRef}
          className="input input-sm is-mono"
          value={name}
          spellCheck={false}
          autoComplete="off"
          placeholder="my-setup"
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <Field label="Short description (optional)">
        <input
          className="input input-sm"
          value={description}
          placeholder="What it helps with"
          onChange={(event) => setDescription(event.target.value)}
        />
      </Field>
      {lists.status === "loading" ? (
        <p className="loading-line">
          <span className="spinner" aria-hidden="true" />
          Loading your skills and MCP servers
        </p>
      ) : (
        <>
          {checklist("Skills", lists.skills, skills, setSkills, "You have no skills of your own yet.")}
          {checklist("MCP servers", lists.servers, servers, setServers, "You have no MCP servers yet.")}
          <p className="settings-footnote">
            Environment variables and headers are not copied. People who install it add their own. Commands, args, and
            URLs are copied as they are, so take any secrets out of them first.
          </p>
          {lists.problem ? <p className="skill-row-problem">{lists.problem}</p> : null}
        </>
      )}
      <div className="plugin-folder-field">
        <Field label="Folder">
          <input
            className="input input-sm is-mono"
            value={folder}
            spellCheck={false}
            autoComplete="off"
            placeholder="/Users/you/my-setup"
            onChange={(event) => setFolder(event.target.value)}
          />
        </Field>
        {pickFolder ? (
          <Button
            size="sm"
            icon="folderOpen"
            aria-label="Choose a folder"
            onClick={() =>
              void pickFolder().then(
                (path) => {
                  if (typeof path === "string" && path) setFolder(path);
                },
                () => undefined,
              )
            }
          >
            Choose
          </Button>
        ) : null}
      </div>
      <span className="field-hint plugin-folder-hint">An empty folder. ZLI writes the plugin there.</span>
      {error ? (
        <p className="inline-error" role="alert">
          <Icon name="alert" size={13} />
          {error}
        </p>
      ) : null}
      <div className="mcp-editor-actions">
        <Button size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" type="submit" loading={busy}>
          Save plugin
        </Button>
      </div>
    </form>
  );
}
