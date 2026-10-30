import type { AgentReachRequest } from "@zli-v2/contracts";
import { useRef, useState } from "react";

import { Button } from "../ui/Button.js";
import { Dialog } from "../ui/Dialog.js";
import { Icon } from "../ui/Icon.js";
import "./setup.css";

/** Asks whether agents may reach other projects, for an agent that is waiting to. */
export function AgentReachDialog({
  request,
  onAnswer,
}: {
  request: AgentReachRequest;
  /** Resolves with a problem to show when the answer did not go through. */
  onAnswer(allow: boolean): Promise<string | undefined>;
}) {
  const allowRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const { agent, project, target } = request;
  const answer = async (allow: boolean) => {
    setBusy(true);
    setError(undefined);
    const failure = await onAnswer(allow);
    setBusy(false);
    if (failure) setError(failure);
  };
  const decline = () => {
    if (!busy) void answer(false);
  };
  return (
    <Dialog
      label="Let agents reach other projects"
      title={target ? `Let ${agent} message ${target.agent}?` : `Let ${agent} see your other projects?`}
      subtitle={
        target
          ? `${agent} in ${project} is trying to reach ${target.agent}, who works in ${target.project}. Agents stay in their own project until you allow this.`
          : `${agent} in ${project} wants to list the agents in your other projects. Agents stay in their own project until you allow this.`
      }
      scrimLabel="Not now"
      initialFocusRef={allowRef}
      onClose={decline}
    >
      <div className="dialog-body setup-approval">
        <p className="setup-note">
          Allowing this lets every agent find, read, and message agents in all your projects, by name.
        </p>
        <p className="setup-note">You can turn it off again in Settings, under Agent messages.</p>
        {error ? (
          <p className="inline-error" role="alert">
            <Icon name="alert" size={13} />
            {error}
          </p>
        ) : null}
      </div>
      <div className="dialog-footer">
        <Button variant="ghost" disabled={busy} onClick={decline}>
          Not now
        </Button>
        <Button variant="primary" ref={allowRef} disabled={busy} onClick={() => void answer(true)}>
          Allow every project
        </Button>
      </div>
    </Dialog>
  );
}
