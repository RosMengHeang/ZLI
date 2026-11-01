import {
  BUILD_CATEGORY_LABELS,
  BUILD_STACK_LABELS,
  type MobileBuildBrief,
  proposalCommandLine,
} from "@zli-v2/contracts";
import { useEffect, useId, useState } from "react";

import { Badge } from "../../../ui/Badge.js";
import { Button } from "../../../ui/Button.js";
import { Field } from "../../../ui/Field.js";
import { errorText } from "../../mobile.js";
import type { MobileDevContext } from "../context.js";
import { copyText, useWorktreeAgent } from "../crash/useWorktreeAgent.js";
import { FindingRow } from "../doctor/DoctorGroup.js";
import "./build.css";

const HINT = "Paste the end of a failed Gradle, Xcode, or EAS build. ZLI finds the first real error.";
const NO_AGENT = "No chat agent works in this worktree";

/** The project check's Build failure group: paste a failed build log and get a brief to fix it or hand to the agent. */
export function BuildGroup({ context }: { context: MobileDevContext }) {
  const build = context.mobile.dev?.build;
  const { worktreeId } = context;
  const [log, setLog] = useState("");
  const [brief, setBrief] = useState<MobileBuildBrief>();
  const [busy, setBusy] = useState<"explain" | "send" | "propose">();
  const [error, setError] = useState<string>();
  const [showContext, setShowContext] = useState(false);
  const agent = useWorktreeAgent(worktreeId);
  const titleId = useId();
  const contextId = useId();

  // biome-ignore lint/correctness/useExhaustiveDependencies: a brief belongs to the worktree it was made for.
  useEffect(() => {
    setBrief(undefined);
    setError(undefined);
  }, [worktreeId]);

  if (!build || !worktreeId) return null;

  const run = async (kind: "explain" | "send" | "propose", work: () => Promise<void>, fallback: string) => {
    if (busy) return;
    setBusy(kind);
    setError(undefined);
    try {
      await work();
    } catch (cause) {
      setError(errorText(cause, fallback));
    } finally {
      setBusy(undefined);
    }
  };
  const explain = () =>
    run(
      "explain",
      async () => {
        setBrief(await build.brief(worktreeId, log));
        setShowContext(false);
      },
      "ZLI could not read this build log.",
    );
  const send = (text: string) =>
    run(
      "send",
      async () => {
        if (await agent.send(text)) context.onNotice(`Sent to the agent in ${agent.name}`);
        else setError("No chat agent works in this worktree.");
      },
      "ZLI could not send the brief to the agent.",
    );
  const propose = (current: MobileBuildBrief) =>
    run(
      "propose",
      async () => {
        const suggestion = current.suggestion;
        if (!suggestion?.action) return;
        await build.propose({
          worktreeId,
          ...(suggestion.title ? { title: suggestion.title } : {}),
          reason: suggestion.text,
          action: suggestion.action,
        });
        context.onNotice("Added the fix as a card. Nothing runs until you choose Run in terminal.");
      },
      "ZLI could not propose the fix.",
    );

  return (
    <section className="mobile-setup-section mobile-build" aria-labelledby={titleId}>
      <h3 className="mobile-setup-title" id={titleId}>
        Build failure
      </h3>
      <Field label="Build log" hint={HINT}>
        <textarea
          className="textarea mobile-build-log"
          rows={6}
          value={log}
          spellCheck={false}
          onChange={(event) => setLog(event.target.value)}
        />
      </Field>
      <div className="mobile-build-actions">
        <Button
          size="sm"
          variant="primary"
          disabled={!log.trim()}
          loading={busy === "explain"}
          onClick={() => void explain()}
        >
          Explain
        </Button>
      </div>
      {error ? (
        <p className="inline-error mobile-build-error" role="alert">
          {error}
        </p>
      ) : null}
      {brief ? (
        <div className="mobile-build-result">
          <div className="mobile-build-head">
            <Badge tone={brief.category === "unknown" ? "neutral" : "danger"}>
              {BUILD_CATEGORY_LABELS[brief.category]}
            </Badge>
            <span className="mobile-build-dim">
              {brief.confidence} confidence, {BUILD_STACK_LABELS[brief.stack]}
              {brief.phase ? `, ${brief.phase}` : ""}
            </span>
          </div>
          <p className="mobile-build-label">First error, line {brief.firstError.lineNumber}</p>
          <pre className="mobile-proposal-well mobile-build-well" id={contextId}>
            {showContext ? (
              brief.firstError.context.map((line, index) => (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: log lines repeat, and their order never changes.
                  key={index}
                  className={line.trim() === brief.firstError.line ? "is-error" : undefined}
                >
                  {`${line}\n`}
                </span>
              ))
            ) : (
              <code>{brief.firstError.line}</code>
            )}
          </pre>
          <Button
            size="xs"
            variant="ghost"
            aria-expanded={showContext}
            aria-controls={contextId}
            onClick={() => setShowContext((open) => !open)}
          >
            {showContext ? "Hide context" : "Show context"}
          </Button>

          <h4 className="mobile-build-subtitle">Version checks</h4>
          {brief.versionChecked === false ? (
            <p className="mobile-build-dim">Version checks did not run.</p>
          ) : brief.versionFindings.length === 0 ? (
            <p className="mobile-build-dim">No version problems found.</p>
          ) : (
            <ul className="mobile-doctor-findings" aria-label="Version problems">
              {brief.versionFindings.map((finding) => (
                <FindingRow key={finding.id} finding={finding} context={context} worktreeId={worktreeId} />
              ))}
            </ul>
          )}

          {brief.likelyFiles.length > 0 ? (
            <>
              <h4 className="mobile-build-subtitle">Likely files</h4>
              <ul className="mobile-build-files">
                {brief.likelyFiles.map((file) => (
                  <li key={file}>{file}</li>
                ))}
              </ul>
            </>
          ) : null}

          <h4 className="mobile-build-subtitle">Avoid</h4>
          <ul className="mobile-build-avoid">
            {brief.avoid.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>

          {brief.suggestion ? (
            <p className="mobile-build-suggestion">
              {brief.suggestion.text}
              {brief.suggestion.action?.kind === "command" ? (
                <code>{proposalCommandLine(brief.suggestion.action)}</code>
              ) : null}
            </p>
          ) : null}

          <div className="mobile-build-actions">
            <Button
              size="xs"
              disabled={!agent.available}
              loading={busy === "send"}
              tooltip={agent.available ? undefined : NO_AGENT}
              onClick={() => void send(brief.text)}
            >
              Send to agent
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => copyText(brief.text, "Copied the build brief.", context.onNotice, setError)}
            >
              Copy brief
            </Button>
            {brief.suggestion?.action ? (
              <Button
                size="xs"
                variant="ghost"
                loading={busy === "propose"}
                aria-label={`Propose fix: ${suggestionName(brief.suggestion)}`}
                onClick={() => void propose(brief)}
              >
                Propose fix
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** What the suggestion's Propose fix button is named for screen readers, next to the findings' own buttons. */
function suggestionName(suggestion: NonNullable<MobileBuildBrief["suggestion"]>): string {
  if (suggestion.title) return suggestion.title;
  const { action } = suggestion;
  if (action?.kind === "command") return proposalCommandLine(action);
  return action ? `write to ${action.file}` : suggestion.text;
}
