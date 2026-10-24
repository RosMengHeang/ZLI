import type { McpImportCandidate, McpImportResult, McpServerConfig } from "@zli-v2/contracts";
import { useEffect, useState } from "react";

import { useRuntime } from "../runtime/RuntimeProvider.js";
import { Button } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { applyServer, scanMcpImports, serverSummary } from "./mcpServers.js";

type Scan = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; result: McpImportResult };

/** Checked unless ZLI has the name already or an earlier candidate uses it. */
export function defaultImportChoice(found: readonly McpImportCandidate[]): boolean[] {
  const taken = new Set<string>();
  return found.map((candidate) => {
    const key = candidate.server.name.toLowerCase();
    if (candidate.exists || taken.has(key)) return false;
    taken.add(key);
    return true;
  });
}

/** The list with the chosen servers appended, or the first problem with one of them. */
export function applyImports(
  servers: readonly McpServerConfig[],
  chosen: readonly McpServerConfig[],
): { servers: McpServerConfig[] } | { problem: string } {
  let next: McpServerConfig[] = [...servers];
  for (const server of chosen) {
    const applied = applyServer(next, server, undefined);
    if ("problem" in applied) return { problem: `${server.name}: ${applied.problem}` };
    next = applied.servers;
  }
  return { servers: next };
}

export function McpImportPanel({
  servers,
  onSave,
  onDone,
}: {
  servers: readonly McpServerConfig[];
  onSave(servers: McpServerConfig[]): Promise<unknown>;
  /** Closes the panel, with the message to show when servers were imported. */
  onDone(message?: string): void;
}) {
  const { dispatch } = useRuntime();
  const [scan, setScan] = useState<Scan>({ status: "loading" });
  const [chosen, setChosen] = useState<boolean[]>([]);
  const [problem, setProblem] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    scanMcpImports(dispatch)
      .then((result) => {
        if (cancelled) return;
        setScan({ status: "ready", result });
        setChosen(defaultImportChoice(result.found));
      })
      .catch((error: unknown) => {
        if (!cancelled) setScan({ status: "error", message: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [dispatch]);

  const found = scan.status === "ready" ? scan.result.found : [];
  const picked = found.filter((candidate, index) => chosen[index] && !candidate.exists);
  const apps = [...new Set(found.map((candidate) => candidate.appLabel))];

  const submit = async () => {
    const applied = applyImports(
      servers,
      picked.map((candidate) => candidate.server),
    );
    if ("problem" in applied) {
      setProblem(applied.problem);
      return;
    }
    setProblem(undefined);
    setSaving(true);
    try {
      await onSave(applied.servers);
      onDone(picked.length === 1 ? "Imported 1 server." : `Imported ${picked.length} servers.`);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="mcp-editor mcp-import" aria-label="Import from other apps">
      <h3 className="mcp-import-title">Import from other apps</h3>
      {scan.status === "loading" ? (
        <p className="loading-line">
          <span className="spinner" aria-hidden="true" />
          Looking for servers
        </p>
      ) : null}
      {scan.status === "error" ? (
        <p className="inline-error" role="alert">
          <Icon name="alert" size={13} />
          {scan.message}
        </p>
      ) : null}
      {scan.status === "ready" && found.length === 0 ? (
        <p className="settings-empty">No servers found in Claude Desktop, Claude Code, Cursor, VS Code, or Windsurf.</p>
      ) : null}
      {apps.map((app) => (
        <fieldset className="skill-candidates mcp-import-group" key={app}>
          <legend className="field-label">{app}</legend>
          {found.map((candidate, index) =>
            candidate.appLabel === app ? (
              <label
                className={`skill-candidate${candidate.exists ? " is-off" : ""}`}
                key={`${candidate.path}:${candidate.server.name}`}
              >
                <input
                  type="checkbox"
                  checked={Boolean(chosen[index]) && !candidate.exists}
                  disabled={candidate.exists || saving}
                  aria-label={`Import ${candidate.server.name} from ${candidate.appLabel}`}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    setChosen((current) => current.map((value, at) => (at === index ? checked : value)));
                  }}
                />
                <span className="mcp-row-copy">
                  <span className="mcp-import-name">
                    <strong>{candidate.server.name}</strong>
                    {candidate.exists ? <span className="mcp-import-exists">Already in ZLI</span> : null}
                  </span>
                  <span className="mcp-row-command" title={serverSummary(candidate.server)}>
                    {serverSummary(candidate.server)}
                  </span>
                  <span className="mcp-import-path" title={candidate.path}>
                    {candidate.path}
                  </span>
                  {candidate.note ? <span className="mcp-import-note">{candidate.note}</span> : null}
                </span>
              </label>
            ) : null,
          )}
        </fieldset>
      ))}
      {scan.status === "ready" && scan.result.problems.length > 0 ? (
        <ul className="mcp-settings-problems">
          {scan.result.problems.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      {problem ? (
        <p className="inline-error" role="alert">
          <Icon name="alert" size={13} />
          {problem}
        </p>
      ) : null}
      <div className="mcp-editor-actions">
        <Button size="sm" disabled={saving} onClick={() => onDone()}>
          {found.length === 0 ? "Close" : "Cancel"}
        </Button>
        {found.length > 0 ? (
          <Button
            size="sm"
            variant="primary"
            loading={saving}
            disabled={picked.length === 0}
            onClick={() => void submit()}
          >
            {picked.length === 1 ? "Import 1 server" : `Import ${picked.length} servers`}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
