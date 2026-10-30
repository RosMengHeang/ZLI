import { AgentToolAccess, AgentToolScope } from "@zli-v2/contracts";
import { useId, useState } from "react";

import { Button } from "../ui/Button.js";
import { Select } from "../ui/Field.js";
import { Icon } from "../ui/Icon.js";
import { AGENT_ACCESS_LABELS, AGENT_SCOPE_LABELS, useMcpServers } from "./mcpServers.js";
import { SectionHeader, SettingGroup, SettingRow } from "./SectionHeader.js";

const ACCESS_HINTS: Record<AgentToolAccess, string> = {
  full: "Agents can list, read, start, and message other agents.",
  read: "Agents can list other agents and read their work, but not start or message them.",
  off: "Agents get no zli tools.",
};

const SCOPE_HINTS: Record<AgentToolScope, string> = {
  project:
    "Agents see only the agents in their own project. When one tries to reach another project, ZLI asks you first.",
  all: "Agents can find, read, and message agents in every project, by name.",
};

/** What agents may do with each other through the zli tool and command, and how far they reach. */
export function AgentMessagesSection() {
  const { state, reload, setAgentAccess, setAgentScope } = useMcpServers();
  const ids = useId();
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string>();

  const run = async (work: () => Promise<unknown>) => {
    setSaving(true);
    setProblem(undefined);
    try {
      await work();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const header = (
    <SectionHeader title="Agent messages">
      Agents talk to each other with the zli tool, or the zli command in terminals, and call each other by name. New
      agents always start in the caller's project.
    </SectionHeader>
  );

  if (state.status === "loading")
    return (
      <>
        {header}
        <p className="loading-line">
          <span className="spinner" aria-hidden="true" />
          Loading agent settings
        </p>
      </>
    );
  if (state.status === "error")
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

  const { agentAccess, agentScope } = state.result;
  return (
    <>
      {header}
      <SettingGroup title="Other agents">
        <SettingRow label="What agents may do" description={ACCESS_HINTS[agentAccess]} htmlFor={`${ids}-access`}>
          <Select<AgentToolAccess>
            id={`${ids}-access`}
            label="What agents may do with other agents"
            value={agentAccess}
            disabled={saving}
            options={AgentToolAccess.options.map((access) => ({ value: access, label: AGENT_ACCESS_LABELS[access] }))}
            onChange={(access) => void run(() => setAgentAccess(access))}
          />
        </SettingRow>
        <SettingRow
          label="Which agents they can reach"
          description={agentAccess === "off" ? "Agent tools are off." : SCOPE_HINTS[agentScope]}
          htmlFor={`${ids}-scope`}
        >
          <Select<AgentToolScope>
            id={`${ids}-scope`}
            label="Which agents they can reach"
            value={agentScope}
            disabled={saving || agentAccess === "off"}
            options={AgentToolScope.options.map((scope) => ({ value: scope, label: AGENT_SCOPE_LABELS[scope] }))}
            onChange={(scope) => void run(() => setAgentScope(scope))}
          />
        </SettingRow>
      </SettingGroup>
      {problem ? (
        <p className="inline-error" role="alert">
          <Icon name="alert" size={13} />
          {problem}
        </p>
      ) : null}
    </>
  );
}
