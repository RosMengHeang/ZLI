import type { ListedProviderKind } from "@zli-v2/contracts";
import { useState } from "react";

import { type AgentStatus, agentStatus, agentUsable } from "../agent/agentStatus.js";
import { isSelectableProvider, signInCommand } from "../agent/providers.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";
import { requestSettings } from "../settings/openSettings.js";
import { Button, IconButton } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { discoverProviders } from "../welcome/welcomeClient.js";

/**
 * Sits on the composer when the chat's agent cannot take a message: not installed, not signed in, its
 * sign-in expired, or its last run said the account has no plan. It says what is wrong in the agent's own
 * words where there are some, and what to do; sending stays off until it goes away.
 */
export function AgentUnavailableNotice({
  name,
  provider,
  status,
}: {
  name: string;
  provider: string;
  status: AgentStatus;
}) {
  const { dispatch } = useRuntime();
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<string>();
  const [copied, setCopied] = useState(false);
  const listed = isSelectableProvider(provider) ? provider : undefined;
  const command = status.kind === "signed-out" && listed ? signInCommand(listed) : undefined;
  const problem = status.kind === "signed-out" || status.kind === "no-plan" ? status.problem : undefined;

  const title =
    status.kind === "missing"
      ? `${name} is not installed`
      : status.kind === "no-plan"
        ? `${name} has no active plan`
        : problem
          ? `${name}'s sign-in expired`
          : `${name} is not signed in`;

  const check = () => {
    setChecking(true);
    setResult(undefined);
    // A failure recorded from a run is forgotten first: re-checking files cannot see a plan being added.
    void discoverProviders(dispatch, problem ? (listed as ListedProviderKind) : undefined).then((outcome) => {
      setChecking(false);
      if (!outcome.ok) {
        setResult(outcome.error);
        return;
      }
      const next = agentStatus(outcome.value.find((entry) => entry.provider === provider));
      if (!agentUsable(next)) setResult(next.kind === "missing" ? "Still not found." : "Still not signed in.");
    });
  };

  return (
    <div className="chat-ended chat-sign-in" role="status">
      <Icon name="alert" size={13} />
      <span className="chat-ended-copy">
        <span className="chat-ended-title">{title}</span>
        <span className="chat-ended-detail">
          {problem ? <>Its last run said: “{problem.message}” </> : null}
          {status.kind === "missing" ? (
            "Install it, then check again. Settings > Accounts has the install command."
          ) : status.kind === "no-plan" ? (
            "Add a plan or credits to this account, or sign in with another, then try again."
          ) : command ? (
            <>
              Run <code>{command}</code> in a terminal and sign in, then check again.
            </>
          ) : (
            `Sign in from ${name}'s own CLI, then check again.`
          )}
          {result ? ` ${result}` : null}
        </span>
      </span>
      {command ? (
        <IconButton
          label={`Copy ${command}`}
          tooltip={copied ? "Copied" : "Copy command"}
          icon={copied ? "check" : "copy"}
          size="sm"
          onClick={() => {
            void navigator.clipboard?.writeText(command).then(
              () => setCopied(true),
              () => undefined,
            );
          }}
        />
      ) : null}
      <Button size="sm" variant="ghost" onClick={() => requestSettings("accounts")}>
        Accounts
      </Button>
      <Button size="sm" disabled={checking} onClick={check}>
        {checking ? "Checking…" : status.kind === "no-plan" ? "Try again" : "Check again"}
      </Button>
    </div>
  );
}
