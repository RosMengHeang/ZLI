import { type MobileProposal, proposalCommandLine } from "@zli-v2/contracts";
import { useEffect, useState } from "react";

import { Button } from "../../ui/Button.js";
import { errorText } from "../mobile.js";
import type { ProposalsBridge } from "./bridge.js";
import type { MobileDevContext } from "./context.js";

/** A file block longer than this many lines starts collapsed. */
const COLLAPSED_LINES = 6;
const SHOWN: ReadonlySet<MobileProposal["state"]> = new Set(["pending", "started", "failed"]);

/**
 * One card per command or file change waiting for the person in this worktree. Nothing runs until they click Run
 * in terminal or Write, and the click sends only the proposal's id.
 */
export function ProposalCards({ context }: { context: MobileDevContext }) {
  const proposals = context.mobile.dev?.proposals;
  const { worktreeId } = context;
  const [list, setList] = useState<readonly MobileProposal[]>([]);
  useEffect(() => {
    if (!proposals || !worktreeId) {
      setList([]);
      return;
    }
    let current = true;
    const unsubscribe = proposals.onChange((next) => {
      if (current) setList(next.filter((proposal) => proposal.worktreeId === worktreeId));
    });
    proposals.list(worktreeId).then(
      (next) => {
        if (current) setList(next);
      },
      () => undefined,
    );
    return () => {
      current = false;
      unsubscribe();
    };
  }, [proposals, worktreeId]);

  const shown = list.filter((proposal) => SHOWN.has(proposal.state));
  if (!proposals || shown.length === 0) return null;
  return (
    <section className="mobile-proposals" aria-label="Proposals">
      {shown.map((proposal) => (
        <ProposalCard key={proposal.proposalId} proposal={proposal} proposals={proposals} context={context} />
      ))}
    </section>
  );
}

function ProposalCard({
  proposal,
  proposals,
  context,
}: {
  proposal: MobileProposal;
  proposals: ProposalsBridge;
  context: MobileDevContext;
}) {
  const [busy, setBusy] = useState<"accept" | "dismiss">();
  const [error, setError] = useState<string>();
  const [expanded, setExpanded] = useState(false);
  const { action } = proposal;
  const started = proposal.state === "started";
  const shownError = error ?? (proposal.state === "failed" ? proposal.error : undefined);

  const act = async (kind: "accept" | "dismiss") => {
    if (busy) return;
    setBusy(kind);
    setError(undefined);
    try {
      if (kind === "dismiss") {
        await proposals.dismiss(proposal.proposalId);
        return;
      }
      const result = await proposals.accept(proposal.proposalId);
      if (result.state === "written" && result.action.kind === "file-block")
        context.onNotice(`Updated ${result.action.file}.`);
    } catch (cause) {
      setError(errorText(cause, kind === "accept" ? "ZLI could not start this." : "ZLI could not dismiss this."));
    } finally {
      setBusy(undefined);
    }
  };

  const blockLines = action.kind === "file-block" ? action.content.replace(/\n+$/u, "").split("\n") : [];
  const collapsible = blockLines.length > COLLAPSED_LINES;
  const titleId = `proposal-${proposal.proposalId}`;

  return (
    <article className="mobile-proposal" aria-labelledby={titleId}>
      <p className="mobile-proposal-source">{proposal.sourceLabel}</p>
      <h3 id={titleId} className="mobile-proposal-title">
        {proposal.title}
      </h3>
      {proposal.reason ? <p className="mobile-proposal-reason">{proposal.reason}</p> : null}
      {action.kind === "command" ? (
        <>
          <pre className="mobile-proposal-well">
            <code>{proposalCommandLine(action)}</code>
          </pre>
          <p className="mobile-proposal-note">
            Runs in {action.cwd === "." ? "the worktree folder" : action.cwd} in a new terminal.
          </p>
        </>
      ) : (
        <>
          <p className="mobile-proposal-note">Adds these lines to {action.file}:</p>
          <pre className="mobile-proposal-well">
            <code>{(collapsible && !expanded ? blockLines.slice(0, COLLAPSED_LINES) : blockLines).join("\n")}</code>
          </pre>
          {collapsible ? (
            <Button size="xs" variant="ghost" aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}>
              {expanded ? "Show less" : "Show all"}
            </Button>
          ) : null}
        </>
      )}
      {started ? <p className="mobile-proposal-state">Running in the terminal drawer</p> : null}
      <div className="mobile-proposal-actions">
        {started ? (
          context.onOpenTerminal ? (
            <Button size="xs" icon="terminal" onClick={context.onOpenTerminal}>
              Open terminal
            </Button>
          ) : null
        ) : (
          <Button size="xs" variant="primary" loading={busy === "accept"} onClick={() => void act("accept")}>
            {action.kind === "command" ? "Run in terminal" : `Write to ${action.file}`}
          </Button>
        )}
        <Button size="xs" variant="ghost" loading={busy === "dismiss"} onClick={() => void act("dismiss")}>
          Dismiss
        </Button>
      </div>
      {shownError ? (
        <p className="inline-error" role="alert">
          {shownError}
        </p>
      ) : null}
    </article>
  );
}
