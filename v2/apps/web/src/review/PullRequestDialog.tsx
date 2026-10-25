import type { PullRequestInfo, PullRequestStatusResult, WorktreeProjection } from "@zli-v2/contracts";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";

import { issueLinkFor, withIssueReference } from "../issues/issueStart.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";
import { Button } from "../ui/Button.js";
import { Dialog } from "../ui/Dialog.js";
import { Field, Select } from "../ui/Field.js";
import { Icon } from "../ui/Icon.js";
import { baseBranchOptions, useBranches } from "./branches.js";
import { openExternalLink, useCopyFeedback } from "./links.js";
import { createPullRequest, pullRequestStatus, pushBranch } from "./pullRequestClient.js";

type Step = "push" | "create";
type Phase =
  | { kind: "loading" }
  | { kind: "form" }
  | { kind: "running"; step: Step }
  | { kind: "failed"; step: Step; message: string }
  | { kind: "done"; pullRequest: PullRequestInfo; existed: boolean };

export function PullRequestDialog({
  worktree,
  base: requestedBase,
  onClose,
  onCreated,
  onCommitFirst,
}: {
  worktree: WorktreeProjection;
  base: string | undefined;
  onClose(): void;
  onCreated(pullRequest: PullRequestInfo): void;
  onCommitFirst(): void;
}) {
  const { bridge, dispatch } = useRuntime();
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [status, setStatus] = useState<PullRequestStatusResult>();
  const [loadError, setLoadError] = useState<string>();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [base, setBase] = useState(requestedBase ?? "");
  const [draft, setDraft] = useState(true);
  const [openError, setOpenError] = useState<string>();
  const [copyState, copy] = useCopyFeedback();
  const titleRef = useRef<HTMLInputElement>(null);
  const openRef = useRef<HTMLButtonElement>(null);
  const worktreeId = worktree.worktreeId;
  const [issueLink] = useState(() => issueLinkFor(worktreeId));
  const { branches } = useBranches(dispatch, worktreeId);
  const baseChoices = baseBranchOptions(branches, base.trim() || undefined);

  const load = async () => {
    setPhase({ kind: "loading" });
    setLoadError(undefined);
    try {
      const next = await pullRequestStatus(dispatch, worktreeId, requestedBase);
      setStatus(next);
      setTitle(next.defaults.title);
      setBody(withIssueReference(next.defaults.body, issueLink));
      setBase(next.defaults.base);
      if (next.pullRequest?.state === "OPEN") setPhase({ kind: "done", pullRequest: next.pullRequest, existed: true });
      else setPhase({ kind: "form" });
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : "The branch could not be read.");
      setPhase({ kind: "form" });
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: the defaults are read once, when the dialog opens.
  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (phase.kind === "form") titleRef.current?.focus();
    if (phase.kind === "done") openRef.current?.focus();
  }, [phase.kind]);

  const branch = status?.branch ?? worktree.branch;
  const uncommitted = status?.uncommittedFiles ?? 0;
  const nothingToPropose = status?.commitsAhead === 0;
  const blocked = !status || !!status.problem || uncommitted > 0 || nothingToPropose;
  const ready = !blocked && title.trim().length > 0 && base.trim().length > 0;

  const submit = async (from: Step = "push") => {
    if (!ready) return;
    let step: Step = from;
    try {
      if (step === "push") {
        setPhase({ kind: "running", step: "push" });
        await pushBranch(dispatch, worktreeId);
        step = "create";
      }
      setPhase({ kind: "running", step: "create" });
      const result = await createPullRequest(dispatch, worktreeId, {
        title: title.trim(),
        body,
        base: base.trim(),
        draft,
      });
      onCreated(result.pullRequest);
      setPhase({ kind: "done", pullRequest: result.pullRequest, existed: false });
    } catch (cause) {
      setPhase({ kind: "failed", step, message: cause instanceof Error ? cause.message : "The request failed." });
    }
  };

  const submitOnModEnter = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void submit();
    }
  };

  const closeOnEscape = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && phase.kind !== "running") onClose();
  };

  const working = phase.kind === "running";

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape from anywhere inside the dialog closes it.
    <div onKeyDown={closeOnEscape}>
      <Dialog
        label="Create pull request"
        className="pr-dialog"
        title={phase.kind === "done" ? `Pull request #${phase.pullRequest.number}` : "Create pull request"}
        subtitle={
          <>
            <span className="is-mono">{branch}</span>
            {phase.kind === "done" ? (
              " on GitHub"
            ) : base.trim() ? (
              <>
                {" "}
                into <span className="is-mono">{base.trim()}</span>
              </>
            ) : null}
          </>
        }
        onClose={() => {
          if (!working) onClose();
        }}
      >
        {phase.kind === "loading" ? (
          <div className="dialog-body">
            <p className="loading-line" role="status">
              <span className="spinner" aria-hidden="true" />
              Reading the commits on {worktree.branch}
            </p>
          </div>
        ) : phase.kind === "done" ? (
          <>
            <div className="dialog-body">
              <p className="pr-result" role="status">
                <Icon name="check" size={14} />
                {phase.existed
                  ? `This branch already has an open ${phase.pullRequest.isDraft ? "draft " : ""}pull request.`
                  : phase.pullRequest.isDraft
                    ? "Opened as a draft. Mark it ready for review on GitHub when it is."
                    : "Opened and ready for review."}
              </p>
              <a className="pr-url" href={phase.pullRequest.url} onClick={(event) => event.preventDefault()}>
                {phase.pullRequest.url}
              </a>
              {openError ? (
                <p className="field-hint is-warning" role="alert">
                  {openError}
                </p>
              ) : null}
            </div>
            <div className="dialog-footer">
              <span className="dialog-footer-note" role="status">
                {copyState === "copied"
                  ? "Link copied."
                  : copyState === "failed"
                    ? "Copy failed. Select the link and copy it."
                    : ""}
              </span>
              <Button variant="ghost" onClick={onClose}>
                Close
              </Button>
              <Button icon={copyState === "copied" ? "check" : "copy"} onClick={() => copy(phase.pullRequest.url)}>
                Copy link
              </Button>
              <Button
                ref={openRef}
                variant="primary"
                icon="externalLink"
                onClick={() => void openExternalLink(bridge, phase.pullRequest.url).then(setOpenError)}
              >
                Open in browser
              </Button>
            </div>
          </>
        ) : phase.kind === "running" || phase.kind === "failed" ? (
          <>
            <div className="dialog-body">
              <ol className="pr-steps" aria-label="Progress">
                <ProgressStep
                  state={stepState(phase, "push")}
                  label={
                    <>
                      Push <span className="is-mono">{branch}</span> to origin
                    </>
                  }
                />
                <ProgressStep
                  state={stepState(phase, "create")}
                  label={draft ? "Open a draft pull request on GitHub" : "Open the pull request on GitHub"}
                />
              </ol>
              {phase.kind === "failed" ? (
                <p className="inline-error pr-error" role="alert">
                  <Icon name="alert" size={13} />
                  <span>{phase.message}</span>
                </p>
              ) : null}
            </div>
            <div className="dialog-footer">
              {phase.kind === "failed" ? (
                <>
                  <Button variant="ghost" onClick={() => setPhase({ kind: "form" })}>
                    Edit details
                  </Button>
                  <Button variant="primary" icon="reload" onClick={() => void submit(phase.step)}>
                    Try again
                  </Button>
                </>
              ) : (
                <Button variant="primary" loading>
                  {phase.step === "push" ? "Pushing" : "Creating"}
                </Button>
              )}
            </div>
          </>
        ) : (
          <form
            className="pr-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="dialog-body">
              {loadError ? (
                <div className="banner banner-danger" role="alert">
                  <Icon name="alert" size={14} />
                  <span className="banner-message">{loadError}</span>
                  <Button size="sm" variant="ghost" onClick={() => void load()}>
                    Check again
                  </Button>
                </div>
              ) : status?.problem ? (
                <div className="banner banner-warning" role="alert">
                  <Icon name="alert" size={14} />
                  <span className="banner-message">{status.problem.message}</span>
                  <Button size="sm" variant="ghost" onClick={() => void load()}>
                    Check again
                  </Button>
                </div>
              ) : uncommitted > 0 ? (
                <div className="banner banner-warning" role="alert">
                  <Icon name="alert" size={14} />
                  <span className="banner-message">
                    {uncommitted} file{uncommitted === 1 ? " has" : "s have"} uncommitted changes. Commit them first so
                    they are part of the pull request.
                  </span>
                  <Button size="sm" variant="ghost" icon="commit" onClick={onCommitFirst}>
                    Commit first
                  </Button>
                </div>
              ) : nothingToPropose ? (
                <div className="banner banner-warning" role="alert">
                  <Icon name="alert" size={14} />
                  <span className="banner-message">
                    {branch} has no commits that {base.trim() || "the base"} does not already have.
                  </span>
                </div>
              ) : null}
              <Field label="Title">
                <input
                  ref={titleRef}
                  className="input"
                  value={title}
                  maxLength={256}
                  onChange={(event) => setTitle(event.target.value)}
                  required
                />
              </Field>
              <Field
                label="Description"
                hint={
                  issueLink
                    ? `Markdown. Starts with the commits since the base branch and closes ${issueLink.reference}.`
                    : "Markdown. Starts with the commits since the base branch."
                }
              >
                <textarea
                  className="textarea pr-body"
                  value={body}
                  rows={7}
                  maxLength={60_000}
                  onChange={(event) => setBody(event.target.value)}
                  onKeyDown={submitOnModEnter}
                />
              </Field>
              <Field label="Base branch">
                {baseChoices.length > 0 ? (
                  <Select
                    label="Base branch"
                    className="is-mono"
                    value={base}
                    options={baseChoices}
                    onChange={setBase}
                  />
                ) : (
                  // Without a list from origin (not fetched yet, or reading it failed), the name can be typed.
                  <input
                    className="input is-mono"
                    value={base}
                    onChange={(event) => setBase(event.target.value)}
                    spellCheck={false}
                    required
                  />
                )}
              </Field>
              <label className="check-field pr-draft">
                <input type="checkbox" checked={draft} onChange={(event) => setDraft(event.target.checked)} />
                <span className="choice-copy">
                  <span className="choice-title">Create as draft</span>
                  <span className="choice-detail">Reviewers are not requested until you mark it ready on GitHub.</span>
                </span>
              </label>
            </div>
            <div className="dialog-footer">
              <span className="dialog-footer-note">
                Pushes <span className="is-mono">{branch}</span> to origin, then runs gh pr create.
              </span>
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button variant="primary" type="submit" icon="pullRequest" disabled={!ready} shortcut="Mod+Enter">
                Create PR
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </div>
  );
}

type StepState = "pending" | "running" | "done" | "failed";

function stepState(phase: Extract<Phase, { kind: "running" | "failed" }>, step: Step): StepState {
  const order: Step[] = ["push", "create"];
  const current = order.indexOf(phase.step);
  const index = order.indexOf(step);
  if (index < current) return "done";
  if (index > current) return "pending";
  return phase.kind === "running" ? "running" : "failed";
}

function ProgressStep({ state, label }: { state: StepState; label: ReactNode }) {
  return (
    <li className={`pr-step is-${state}`}>
      {state === "running" ? (
        <span className="spinner" aria-hidden="true" />
      ) : (
        <Icon name={state === "done" ? "check" : state === "failed" ? "alert" : "circle"} size={14} />
      )}
      <span>{label}</span>
      <span className="sr-only">
        {state === "running" ? " (in progress)" : state === "done" ? " (done)" : state === "failed" ? " (failed)" : ""}
      </span>
    </li>
  );
}
