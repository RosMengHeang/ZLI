import type { ProviderUpdateInfo } from "@zli-v2/contracts";
import { useEffect, useState } from "react";

import { useRuntime } from "../runtime/RuntimeProvider.js";
import { SettingsGroup } from "../settings/SettingsLayout.js";
import { Button } from "../ui/Button.js";
import { ProviderMark } from "../ui/ProviderMark.js";
import {
  type AgentUpdateNote,
  checkAgentUpdates,
  pendingAgentUpdates,
  runAgentUpdate,
  runAllAgentUpdates,
  useAgentUpdates,
} from "./agentUpdatesStore.js";

type Note = AgentUpdateNote;

/** What the row says under the agent's name. */
export function agentVersionText(update: ProviderUpdateInfo): string {
  if (update.status === "behind") return `${update.current} installed, ${update.latest} is out`;
  if (update.status === "current") return `Up to date, ${update.current}`;
  return update.current ? `Version ${update.current}` : "Version unknown";
}

/**
 * The agent CLIs ZLI found, each against its newest version, with a button that updates it through the
 * package manager that installed it. An install ZLI cannot place shows the command to run by hand.
 */
export function AgentUpdates() {
  const { dispatch } = useRuntime();
  const agentUpdates = useAgentUpdates();
  const { updates, checking, running, notes } = agentUpdates;
  const checkError = agentUpdates.error;
  const check = () => checkAgentUpdates(dispatch);
  const update = (provider: ProviderUpdateInfo["provider"]) => runAgentUpdate(dispatch, provider);
  const behind = pendingAgentUpdates(agentUpdates);
  const updateAll = () => runAllAgentUpdates(dispatch);

  // Settings always asks afresh, so "Check again" is only needed for a later look.
  // biome-ignore lint/correctness/useExhaustiveDependencies: one check each time the page opens.
  useEffect(() => {
    void checkAgentUpdates(dispatch);
  }, []);

  return (
    <SettingsGroup
      title="Agents"
      description="The agent CLIs ZLI runs. Each one updates through the tool that installed it."
      bare
      actions={
        <>
          {behind.length > 1 ? (
            <Button size="sm" variant="primary" icon="download" disabled={running.size > 0} onClick={updateAll}>
              Update all
            </Button>
          ) : null}
          <Button size="sm" icon="reload" loading={checking} disabled={running.size > 0} onClick={() => void check()}>
            Check again
          </Button>
        </>
      }
    >
      {checkError ? <p className="inline-error">{checkError}</p> : null}
      {updates === undefined ? (
        checkError ? null : (
          <p className="settings-empty">Looking for agents…</p>
        )
      ) : updates.length === 0 ? (
        <p className="settings-empty">No agent CLIs are installed yet.</p>
      ) : (
        <ul className="agent-updates">
          {updates.map((entry) => (
            <AgentRow
              key={entry.provider}
              entry={entry}
              busy={running.has(entry.provider)}
              note={notes[entry.provider]}
              onUpdate={() => void update(entry.provider)}
            />
          ))}
        </ul>
      )}
    </SettingsGroup>
  );
}

function AgentRow({
  entry,
  busy,
  note,
  onUpdate,
}: {
  entry: ProviderUpdateInfo;
  busy: boolean;
  note: Note | undefined;
  onUpdate(): void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    if (!entry.command) return;
    void navigator.clipboard
      ?.writeText(entry.command)
      .then(() => setCopied(true))
      .catch(() => undefined);
  };
  return (
    <li className={`agent-update${entry.status === "behind" ? " is-behind" : ""}`}>
      <ProviderMark provider={entry.provider} size={18} />
      <div className="agent-update-copy">
        <span className="agent-update-name">{entry.displayName}</span>
        <span className="agent-update-version" role="status">
          {busy ? `Updating with ${entry.command ?? "its installer"}…` : agentVersionText(entry)}
        </span>
        {note && !busy ? (
          <span className={`agent-update-note is-${note.tone}`}>
            {note.text}
            {note.output ? <pre className="agent-update-output">{note.output}</pre> : null}
          </span>
        ) : null}
      </div>
      <div className="agent-update-action">
        {entry.status === "current" ? null : entry.canUpdate ? (
          <Button
            size="sm"
            variant={entry.status === "behind" ? "primary" : "secondary"}
            loading={busy}
            tooltip={entry.command}
            onClick={onUpdate}
          >
            Update
          </Button>
        ) : entry.command ? (
          <Button size="sm" icon={copied ? "check" : "copy"} tooltip={entry.command} onClick={copy}>
            {copied ? "Copied" : "Copy command"}
          </Button>
        ) : null}
      </div>
    </li>
  );
}
