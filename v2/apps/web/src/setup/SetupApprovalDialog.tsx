import type { ProjectProjection, SetupDecision, WorktreeProjection, WorktreeSetupProjection } from "@zli-v2/contracts";
import { useRef, useState } from "react";

import { Button } from "../ui/Button.js";
import { Dialog } from "../ui/Dialog.js";
import { Icon } from "../ui/Icon.js";
import "./setup.css";

const SHOWN_COPIES = 6;

export function SetupApprovalDialog({
  setup,
  project,
  worktree,
  onRespond,
  onDefer,
}: {
  setup: WorktreeSetupProjection;
  project: ProjectProjection | undefined;
  worktree: WorktreeProjection | undefined;
  onRespond(decision: SetupDecision): Promise<string | undefined>;
  onDefer(): void;
}) {
  const runRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const respond = async (decision: SetupDecision) => {
    setBusy(true);
    setError(undefined);
    const failure = await onRespond(decision);
    setBusy(false);
    if (failure) setError(failure);
  };
  const extraCopies = setup.copied.length - SHOWN_COPIES;
  return (
    <Dialog
      label="Approve setup commands"
      title={`Run setup for ${worktree?.branch ?? "the new worktree"}?`}
      subtitle={`${project?.name ?? "This project"}'s zli.json asks to run ${
        setup.commands.length === 1 ? "this command" : `these ${setup.commands.length} commands`
      } in the new worktree. They run with your permissions, and agents for this worktree start after setup finishes.`}
      scrimLabel="Decide later"
      initialFocusRef={runRef}
      onClose={onDefer}
    >
      <div className="dialog-body setup-approval">
        <ol className="setup-commands" aria-label="Setup commands">
          {setup.commands.map((command, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the list is fixed by its hash and may repeat a command.
            <li key={index}>
              <code>{command}</code>
            </li>
          ))}
        </ol>
        {setup.copied.length > 0 ? (
          <p className="setup-note">
            Copied from the main checkout: {setup.copied.slice(0, SHOWN_COPIES).join(", ")}
            {extraCopies > 0 ? `, and ${extraCopies} more` : ""}.
          </p>
        ) : null}
        {setup.skipped.length > 0 ? (
          <p className="setup-note" title={setup.skipped.map((entry) => `${entry.entry}: ${entry.reason}`).join("\n")}>
            Not copied: {setup.skipped.map((entry) => entry.entry).join(", ")}.
          </p>
        ) : null}
        <p className="setup-note">
          "Always run" remembers this exact list for {project?.name ?? "the project"}. If zli.json changes it, ZLI asks
          again.
        </p>
        {error ? (
          <p className="inline-error" role="alert">
            <Icon name="alert" size={13} />
            {error}
          </p>
        ) : null}
      </div>
      <div className="dialog-footer">
        <Button variant="ghost" disabled={busy} onClick={() => void respond("skip")}>
          Skip setup
        </Button>
        <Button disabled={busy} onClick={() => void respond("always")}>
          Always run for this project
        </Button>
        <Button variant="primary" ref={runRef} disabled={busy} onClick={() => void respond("run-once")}>
          Run once
        </Button>
      </div>
    </Dialog>
  );
}
