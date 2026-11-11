import type {
  PullRequestInfo,
  RuntimeProjection,
  ThreadActivityTodo,
  ThreadMessageProjection,
} from "@zli-v2/contracts";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";

import { openExternalLink } from "../review/links.js";
import { usePullRequestEntry } from "../review/pullRequestStore.js";
import { useRuntime, useRuntimeSelector } from "../runtime/RuntimeProvider.js";
import { entriesForThread, shallowArrayEqual } from "../runtime/runtimeStore.js";
import { AnimalAvatar } from "../teammates/AnimalAvatar.js";
import type { Animal } from "../teammates/teammates.js";
import { Button, IconButton } from "../ui/Button.js";
import { Collapse } from "../ui/Collapse.js";
import { Icon } from "../ui/Icon.js";
import { Markdown } from "./Markdown.js";

/* ---------- The agent's plan ---------- */

/**
 * The plan the agent keeps while it works, pinned above the message box: each step ticks off as it finishes,
 * the one in progress shimmers. Folds to one line, and goes away once every step is done and the turn is over.
 */
export function PlanCard({
  todos,
  working,
  onDismiss,
}: {
  todos: readonly ThreadActivityTodo[];
  working: boolean;
  onDismiss(): void;
}) {
  const done = todos.filter((todo) => todo.status === "completed").length;
  const current = todos.find((todo) => todo.status === "in_progress");
  const finished = done === todos.length;
  const [open, setOpen] = useState(!finished);
  // Once every step is done the plan folds to one line, giving the message box its room back.
  useEffect(() => {
    if (finished) setOpen(false);
  }, [finished]);
  return (
    <section className={`plan-card${finished ? " is-done" : ""}`} aria-label="The agent's plan">
      <div className="tray-head plan-card-head">
        <button type="button" className="plan-card-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          {finished ? <Icon name="check" size={12} className="plan-card-done" /> : null}
          <span className="tray-title">{finished ? "Plan done" : "Plan"}</span>
          {!open && current ? <span className="plan-card-now">{current.text}</span> : <span className="tray-meta" />}
          <span className="plan-card-steps" aria-hidden="true">
            {todos.length <= 12
              ? todos.map((todo, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: one tick per step, in the plan's own order.
                  <span key={index} className={`plan-card-tick is-${todo.status}`} />
                ))
              : null}
          </span>
          <span className="plan-card-count">
            {done}/{todos.length}
          </span>
          <Icon name="chevronDown" size={12} className="plan-card-chevron" />
        </button>
        {!working ? (
          <IconButton label="Hide the plan" tooltip="Hide" icon="x" size="xs" iconSize={11} onClick={onDismiss} />
        ) : null}
      </div>
      <Collapse open={open}>
        <ol className="plan-card-list">
          {todos.map((todo, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a plan can repeat a step's words, and its order never changes in place.
            <li key={`${index}-${todo.text}`} className={`plan-step is-${todo.status}`}>
              <span className="plan-step-mark" aria-hidden="true">
                {todo.status === "completed" ? <Icon name="check" size={12} /> : null}
              </span>
              <span className={`plan-step-text${todo.status === "in_progress" && working ? " shimmer-text" : ""}`}>
                {todo.text}
              </span>
              <span className="sr-only">
                {todo.status === "completed" ? ", done" : todo.status === "in_progress" ? ", in progress" : ""}
              </span>
            </li>
          ))}
        </ol>
      </Collapse>
    </section>
  );
}

/** A plan the agent wrote in read-only mode, waiting for the go-ahead to make the changes. */
export function PlanApproval({
  displayName,
  canSwitch,
  onApprove,
  onChange,
}: {
  displayName: string;
  /** The agent can leave read-only mode in this chat, so approving also lets it edit. */
  canSwitch: boolean;
  onApprove(): void;
  onChange(): void;
}) {
  return (
    <section className="plan-approval" aria-label="Approve the plan">
      <span className="plan-approval-copy">
        <span className="plan-approval-title">Ready to build this?</span>
        <span className="plan-approval-detail">
          {canSwitch
            ? `${displayName} only planned. Approve to let it make the changes.`
            : `${displayName} only planned.`}
        </span>
      </span>
      <Button size="sm" variant="ghost" onClick={onChange}>
        Change plan
      </Button>
      <Button size="sm" variant="primary" onClick={onApprove}>
        Approve and start
      </Button>
    </section>
  );
}

/* ---------- Picking up after a cut ---------- */

/** The chat stopped in the middle of a task, for example when the app closed. One click carries on. */
export function ContinueRow({ onContinue }: { onContinue(): void }) {
  return (
    <div className="chat-continue">
      <span className="chat-continue-line" aria-hidden="true" />
      <Button size="xs" variant="secondary" icon="play" onClick={onContinue}>
        Continue
      </Button>
      <span className="chat-continue-line" aria-hidden="true" />
    </div>
  );
}

/* ---------- Follow-ups ---------- */

const FOLLOW_UP_HEADING =
  /^\s*(?:#{1,4}\s*)?(?:\*\*)?\s*(?:suggested\s+)?(?:next steps?|follow[- ]?ups?|what(?:'|’)?s next|you (?:could|might) also|possible improvements|further improvements)\b[^\n]*$/imu;
const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+(.+)$/u;

/** The tasks a reply suggests for later: the list under a "Next steps" or "Follow-ups" heading. */
export function followUpsIn(text: string): string[] {
  const heading = FOLLOW_UP_HEADING.exec(text);
  if (!heading) return [];
  const after = text.slice(heading.index + heading[0].length).split(/\r?\n/u);
  const items: string[] = [];
  for (const line of after) {
    const bullet = BULLET.exec(line);
    if (bullet?.[1]) {
      const clean = bullet[1]
        .replace(/\*\*|__|`/gu, "")
        .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
        .trim();
      if (clean.length >= 6) items.push(clean.length > 200 ? `${clean.slice(0, 199)}…` : clean);
      if (items.length === 4) break;
      continue;
    }
    if (line.trim() === "" && items.length === 0) continue;
    if (line.trim() === "" || /^\s*#/u.test(line)) break;
    if (items.length > 0 && /^\s{2,}\S/u.test(line)) continue;
    if (items.length > 0) break;
  }
  return items;
}

/** The suggestions of the latest reply as cards: do one here, or start it as its own chat. */
export function FollowUps({
  items,
  onHere,
  onNewChat,
}: {
  items: readonly string[];
  onHere(task: string): void;
  onNewChat?: ((task: string) => void) | undefined;
}) {
  return (
    <section className="follow-ups" aria-label="Suggested next steps">
      {items.map((item) => (
        <div className="follow-up" key={item}>
          <Icon name="sparkle" size={12} />
          <span className="follow-up-text" title={item}>
            {item}
          </span>
          <span className="follow-up-actions">
            <Button size="xs" variant="ghost" onClick={() => onHere(item)}>
              Do it here
            </Button>
            {onNewChat ? (
              <Button size="xs" variant="ghost" icon="squarePen" onClick={() => onNewChat(item)}>
                New chat
              </Button>
            ) : null}
          </span>
        </div>
      ))}
    </section>
  );
}

/* ---------- Review findings ---------- */

export type ReviewFinding = { file: string; line?: number; text: string };

const FINDING_REF = /`?((?:[\w@.-]+\/)*[\w@.-]+\.[A-Za-z0-9]{1,6})(?::(\d+)(?:[-–]\d+)?)?`?/u;

/**
 * The findings of a review reply: its list items that name a file, such as "- `src/app.ts:12` misses a null
 * check". Two or more make a review; fewer is an ordinary answer.
 */
export function reviewFindings(text: string): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const bullet = BULLET.exec(line);
    if (!bullet?.[1]) continue;
    const ref = FINDING_REF.exec(bullet[1]);
    if (!ref?.[1]?.includes(".")) continue;
    const rest = bullet[1]
      .replace(ref[0], "")
      .replace(/^[\s:—–-]+/u, "")
      .replace(/\*\*|__|`/gu, "")
      .trim();
    if (rest.length < 4) continue;
    findings.push({ file: ref[1], ...(ref[2] ? { line: Number(ref[2]) } : {}), text: rest });
    if (findings.length === 30) break;
  }
  return findings.length >= 2 ? findings : [];
}

/** A review's findings grouped by file, with a fix for one or for all. */
export function ReviewCard({
  findings,
  onFixAll,
  onFixOne,
  onOpenFile,
}: {
  findings: readonly ReviewFinding[];
  onFixAll(): void;
  onFixOne(finding: ReviewFinding): void;
  onOpenFile?: ((path: string) => void) | undefined;
}) {
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const keyOf = (finding: ReviewFinding) => `${finding.file}:${finding.line ?? ""}:${finding.text}`;
  const open = findings.filter((finding) => !dismissed.has(keyOf(finding)));
  const files = [...new Set(open.map((finding) => finding.file))];
  if (open.length === 0) return null;
  return (
    <section className="review-card" aria-label="Review findings">
      <header className="review-card-head">
        <Icon name="eye" size={13} />
        <span className="review-card-title">
          Review · {open.length} {open.length === 1 ? "finding" : "findings"} in {files.length}{" "}
          {files.length === 1 ? "file" : "files"}
        </span>
        <Button size="xs" variant="primary" icon="wrench" onClick={onFixAll}>
          Fix all
        </Button>
      </header>
      {files.map((file) => (
        <div className="review-file" key={file}>
          <button
            type="button"
            className="review-file-name"
            disabled={!onOpenFile}
            onClick={() => onOpenFile?.(file)}
            title={onOpenFile ? `Open ${file}` : file}
          >
            <Icon name="file" size={11} />
            {file}
          </button>
          <ul>
            {open
              .filter((finding) => finding.file === file)
              .map((finding) => (
                <li key={keyOf(finding)} className="review-finding">
                  {finding.line ? <span className="review-finding-line">{finding.line}</span> : null}
                  <span className="review-finding-text">{finding.text}</span>
                  <span className="review-finding-actions">
                    <Button size="xs" variant="ghost" onClick={() => onFixOne(finding)}>
                      Fix this one
                    </Button>
                    <IconButton
                      label="Dismiss this finding"
                      tooltip="Dismiss"
                      icon="x"
                      size="xs"
                      iconSize={10}
                      onClick={() => setDismissed((current) => new Set(current).add(keyOf(finding)))}
                    />
                  </span>
                </li>
              ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

/* ---------- The branch's pull request ---------- */

type ChecksSummary = { state: "passed" | "failed" | "pending" | "none"; failed: number; total: number };

export function checksSummary(pullRequest: PullRequestInfo): ChecksSummary {
  const checks = (pullRequest.checks ?? []).filter((check) => check.state !== "skipped");
  const failed = checks.filter((check) => check.state === "failed").length;
  if (checks.length === 0) return { state: "none", failed: 0, total: 0 };
  if (failed > 0) return { state: "failed", failed, total: checks.length };
  if (checks.some((check) => check.state === "pending")) return { state: "pending", failed: 0, total: checks.length };
  return { state: "passed", failed: 0, total: checks.length };
}

/**
 * The pull request of the chat's branch, under the conversation: its checks, and a way to have the agent fix the
 * ones that fail. Absent until the branch has an open pull request.
 */
export function PullRequestStrip({
  worktreeId,
  displayName,
  onAsk,
}: {
  worktreeId: string | undefined;
  displayName: string;
  onAsk?: ((text: string) => void) | undefined;
}) {
  const { bridge } = useRuntime();
  const entry = usePullRequestEntry(worktreeId);
  const pullRequest = entry?.status?.pullRequest;
  if (!pullRequest || pullRequest.state === "CLOSED") return null;
  const checks = checksSummary(pullRequest);
  const merged = pullRequest.state === "MERGED";
  const failedNames = (pullRequest.checks ?? []).filter((check) => check.state === "failed").map((check) => check.name);
  return (
    <section className={`pr-strip is-${merged ? "merged" : checks.state}`} aria-label="Pull request">
      <Icon name={merged ? "merge" : "pullRequest"} size={13} />
      <button
        type="button"
        className="pr-strip-title"
        title={`Open #${pullRequest.number} on GitHub`}
        onClick={() => {
          if (bridge) void openExternalLink(bridge, pullRequest.url);
        }}
      >
        <span className="pr-strip-number">#{pullRequest.number}</span>
        <span className="pr-strip-name">{pullRequest.title ?? "Pull request"}</span>
      </button>
      <span className="pr-strip-checks">
        {merged
          ? "Merged"
          : checks.state === "failed"
            ? `${checks.failed} of ${checks.total} checks failed`
            : checks.state === "pending"
              ? "Checks running"
              : checks.state === "passed"
                ? "Checks passed"
                : pullRequest.isDraft
                  ? "Draft"
                  : "Open"}
      </span>
      {!merged && checks.state === "failed" && onAsk ? (
        <Button
          size="xs"
          variant="secondary"
          icon="wrench"
          tooltip={`Ask ${displayName} to fix ${failedNames.join(", ")}`}
          onClick={() =>
            onAsk(
              `The pull request's checks failed: ${failedNames.join(", ")}. Find out why with gh, fix it, and push.`,
            )
          }
        >
          Fix failing checks
        </Button>
      ) : null}
    </section>
  );
}

/* ---------- An empty chat ---------- */

/** Three ways to begin, under "What should we work on?", so an empty chat never asks for a blank page. */
export function StartSuggestions({ folder, onPick }: { folder: string | undefined; onPick(text: string): void }) {
  const where = folder ? ` ${folder}` : " this project";
  const ideas = [
    { icon: "eye" as const, label: "Explain how it fits together", text: `Explain how${where} is organised` },
    {
      icon: "wrench" as const,
      label: "Find and fix a bug",
      text: "Look through the recent changes for bugs and fix what you find",
    },
    {
      icon: "check" as const,
      label: "Add missing tests",
      text: "Find the code with the least test coverage and add tests",
    },
  ];
  return (
    <div className="start-ideas">
      {ideas.map((idea) => (
        <button key={idea.label} type="button" className="start-idea" onClick={() => onPick(idea.text)}>
          <Icon name={idea.icon} size={13} />
          {idea.label}
        </button>
      ))}
    </div>
  );
}

/* ---------- A side question ---------- */

/**
 * A question beside the chat: it reads the conversation but never writes to it. The answer comes from a short
 * read-only chat of its own, shown here and closed with the panel.
 */
export function SideChat({
  animal,
  threadId,
  starting,
  error,
  onAsk,
  onClose,
}: {
  animal: Animal;
  /** The side chat's thread, once the first question started it. */
  threadId: string | undefined;
  starting: boolean;
  error: string | undefined;
  onAsk(question: string): void;
  onClose(): void;
}) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const said = useRuntimeSelector(
    useCallback(
      (value: RuntimeProjection | undefined) => (threadId ? entriesForThread(value?.messages, threadId) : NO_MESSAGES),
      [threadId],
    ),
    shallowArrayEqual,
  );
  const status = useRuntimeSelector(
    useCallback(
      (value: RuntimeProjection | undefined) =>
        threadId ? value?.threads.find((thread) => thread.threadId === threadId)?.status : undefined,
      [threadId],
    ),
  );
  const thinking = starting || status === "working" || status === "starting";
  const shown = said.filter((message) => message.role === "user" || message.role === "assistant");
  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  });
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const question = draft.trim();
    if (!question || thinking) return;
    setDraft("");
    onAsk(question);
  };
  return (
    <section className="side-chat" aria-label="Side question">
      <header className="tray-head side-chat-head">
        <AnimalAvatar animal={animal} size={16} mood={thinking ? "thinking" : "idle"} />
        <span className="tray-title">Side question</span>
        <span className="tray-meta">Not added to the chat</span>
        <IconButton label="Close the side question" tooltip="Close (Esc)" icon="x" size="xs" onClick={onClose} />
      </header>
      {shown.length > 0 || thinking || error ? (
        <div className="side-chat-log" ref={logRef}>
          {shown.map((message) =>
            message.role === "user" ? (
              <p key={message.messageId} className="side-chat-ask">
                {askedIn(message.text)}
              </p>
            ) : (
              <div key={message.messageId} className="side-chat-answer">
                <Markdown text={message.text} links={undefined} />
              </div>
            ),
          )}
          {thinking ? <p className="side-chat-thinking shimmer-text">Thinking</p> : null}
          {error ? (
            <p className="inline-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
      <form className="side-chat-form" onSubmit={submit}>
        <textarea
          ref={inputRef}
          rows={1}
          value={draft}
          aria-label="Side question"
          placeholder="Ask about this chat. The answer stays here."
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onClose();
            } else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <IconButton
          label="Ask"
          tooltip="Ask"
          icon="arrowUp"
          size="sm"
          type="submit"
          disabled={!draft.trim() || thinking}
        />
      </form>
    </section>
  );
}

const NO_MESSAGES: readonly ThreadMessageProjection[] = [];

/** The question as the person typed it: the message also carries the conversation and the ground rules first. */
function askedIn(text: string): string {
  return text.split("\n\n").at(-1)?.trim() || text;
}
