import type { ProjectProjection } from "@zli-v2/contracts";
import { useRef, useState } from "react";

import { Button } from "../ui/Button.js";
import { Dialog } from "../ui/Dialog.js";
import { Icon } from "../ui/Icon.js";
import "./setup.css";

export function AgentTrustDialog({
  project,
  onTrust,
  onDecline,
}: {
  project: ProjectProjection | undefined;
  onTrust(): Promise<string | undefined>;
  onDecline(): void;
}) {
  const trustRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const name = project?.name ?? "this project";
  const trust = async () => {
    setBusy(true);
    setError(undefined);
    const failure = await onTrust();
    setBusy(false);
    if (failure) setError(failure);
  };
  return (
    <Dialog
      label="Let agents work in this project"
      title={`Let agents work in ${name}?`}
      subtitle={`Agent CLIs ask whether you trust a folder before they read its files and settings. ZLI asks once for ${name} and answers for every agent in it and its worktrees.`}
      scrimLabel="Not now"
      initialFocusRef={trustRef}
      onClose={onDecline}
    >
      <div className="dialog-body setup-approval">
        <p className="setup-note">
          Settings in the project can add tools and commands for agents, so only say yes for code you trust.
        </p>
        <p className="setup-note">
          This does not change what agents may do without asking. Each agent's permission mode still decides that.
        </p>
        {project ? <p className="setup-note">{project.path}</p> : null}
        {error ? (
          <p className="inline-error" role="alert">
            <Icon name="alert" size={13} />
            {error}
          </p>
        ) : null}
      </div>
      <div className="dialog-footer">
        <Button variant="ghost" disabled={busy} onClick={onDecline}>
          Not now
        </Button>
        <Button variant="primary" ref={trustRef} disabled={busy} onClick={() => void trust()}>
          Let agents work
        </Button>
      </div>
    </Dialog>
  );
}
