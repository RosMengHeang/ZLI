import { describeApproval, describeQuestions, type InputQuestion } from "@zli-v2/client-runtime";
import type { ThreadRequestProjection } from "@zli-v2/contracts";
import { useMemo, useState } from "react";

import { Button, IconButton } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";

/** One open request and how to answer it, for whichever agent in the chat asked. */
export type PendingRequest = {
  request: ThreadRequestProjection;
  provider: string;
  displayName: string;
  onRespond(decision: unknown): Promise<void>;
  onAnswer(answers: Record<string, string>): Promise<void>;
};

type RequestPosition = { index: number; total: number; onPrevious(): void; onNext(): void };

/**
 * Every open request in the chat, the host's and its guests', in one card. With more than one it pages
 * through them, so two cards never stack above the message box.
 */
export function RequestPager({ requests }: { requests: readonly PendingRequest[] }) {
  const [chosen, setChosen] = useState<string>();
  // Follows the request by id, so answering one never jumps the card to another agent's mid-read.
  const found = requests.findIndex((entry) => entry.request.requestId === chosen);
  const index = found >= 0 ? found : 0;
  if (requests.length === 0) return null;
  const go = (step: number) => {
    const next = requests[(index + step + requests.length) % requests.length];
    if (next) setChosen(next.request.requestId);
  };
  // Every card stays mounted and only the current one shows, so answers typed into one survive paging away.
  return (
    <>
      {requests.map((entry, at) => (
        <div key={entry.request.requestId} hidden={at !== index}>
          <RequestCard
            {...entry}
            position={
              requests.length > 1
                ? { index: at, total: requests.length, onPrevious: () => go(-1), onNext: () => go(1) }
                : undefined
            }
          />
        </div>
      ))}
    </>
  );
}

export function RequestCard({
  request,
  provider,
  displayName,
  position,
  onRespond,
  onAnswer,
}: PendingRequest & {
  /** Where this request sits among the open ones, when there is more than one. */
  position?: RequestPosition | undefined;
}) {
  const [busy, setBusy] = useState<string>();
  const approval = request.kind === "approval";
  const act = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    try {
      await action();
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <section className="chat-request" aria-label={approval ? "Approval request" : "Input request"}>
      <header className="chat-request-head">
        <span className="chat-request-title">
          <span className="chat-request-pulse" aria-hidden="true" />
          {approval ? `${displayName} asks to continue` : `${displayName} has a question`}
        </span>
        {position ? (
          <span className="chat-request-pager">
            <IconButton
              label="Previous request"
              icon="chevronRight"
              size="xs"
              iconSize={12}
              className="chat-request-prev"
              onClick={position.onPrevious}
            />
            <span className="chat-request-count">
              {position.index + 1} of {position.total}
            </span>
            <IconButton label="Next request" icon="chevronRight" size="xs" iconSize={12} onClick={position.onNext} />
          </span>
        ) : null}
      </header>
      {approval ? (
        <ApprovalBody
          request={request}
          provider={provider}
          busy={busy}
          onChoose={(key, decision) => void act(key, () => onRespond(decision))}
        />
      ) : (
        <QuestionForm
          key={request.requestId}
          request={request}
          busy={busy !== undefined}
          onSubmit={(answers) => void act("answer", () => onAnswer(answers))}
        />
      )}
    </section>
  );
}

function ApprovalBody({
  request,
  provider,
  busy,
  onChoose,
}: {
  request: ThreadRequestProjection;
  provider: string;
  busy: string | undefined;
  onChoose(key: string, decision: unknown): void;
}) {
  const view = useMemo(() => describeApproval(provider, request.payload), [provider, request.payload]);
  return (
    <>
      <p className="chat-request-heading">{view.title}</p>
      {view.fields.length > 0 ? (
        <dl className="chat-request-fields">
          {view.fields.map((field) => (
            <div key={field.label} className="chat-request-field">
              <dt>{field.label}</dt>
              <dd className={field.mono ? "is-mono" : undefined}>{field.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {/* The main choice, Approve, sits at the far right, where Send is on a question; the rest line up to its left. */}
      <div className="chat-request-actions">
        {[...view.choices].reverse().map((choice) => (
          <Button
            key={choice.key}
            variant={choice.tone}
            size="sm"
            loading={busy === choice.key}
            disabled={busy !== undefined && busy !== choice.key}
            onClick={() => onChoose(choice.key, choice.decision)}
          >
            {choice.label}
          </Button>
        ))}
      </div>
    </>
  );
}

/**
 * Several questions are asked one at a time, the way a person would ask them. Picking a choice moves on by
 * itself; a typed answer moves on with Next or Enter. Back goes to the question before, keeping its answer.
 */
function QuestionForm({
  request,
  busy,
  onSubmit,
}: {
  request: ThreadRequestProjection;
  busy: boolean;
  onSubmit(answers: Record<string, string>): void;
}) {
  const questions = useMemo(() => describeQuestions(request.payload), [request.payload]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [step, setStep] = useState(0);
  const last = questions.length - 1;
  const current = questions[Math.min(step, last)];
  const answered = (id: string | undefined) => (id ? (answers[id] ?? "").trim().length > 0 : false);
  const complete = questions.every((question) => answered(question.id));
  const set = (id: string, value: string) => setAnswers((existing) => ({ ...existing, [id]: value }));
  const next = () => {
    if (!answered(current?.id)) return;
    if (step < last) setStep(step + 1);
    else if (complete && !busy) onSubmit(answers);
  };
  if (!current) return null;
  return (
    <form
      className="chat-request-form"
      onSubmit={(event) => {
        event.preventDefault();
        next();
      }}
    >
      {questions.length > 1 ? (
        <div className="chat-request-steps">
          <span className="chat-request-step-count">
            Question {step + 1} of {questions.length}
          </span>
          <span className="chat-request-step-dots" aria-hidden="true">
            {questions.map((question, index) => (
              <span
                key={question.id}
                className={`chat-request-step-dot${index === step ? " is-current" : answered(question.id) ? " is-done" : ""}`}
              />
            ))}
          </span>
        </div>
      ) : null}
      {/* Keyed by question, so each step slides in. */}
      <Question
        key={current.id}
        question={current}
        value={answers[current.id] ?? ""}
        onChange={set}
        onPick={(id, value) => {
          set(id, value);
          // A pick is a whole answer, so the next question follows after a beat to show the choice.
          if (step < last) window.setTimeout(() => setStep((at) => (at === step ? at + 1 : at)), 160);
        }}
      />
      <div className="chat-request-actions">
        {step > 0 ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => setStep(step - 1)}>
            Back
          </Button>
        ) : null}
        <Button
          type="submit"
          variant="primary"
          size="sm"
          loading={busy && step === last}
          disabled={step < last ? !answered(current.id) : !complete}
        >
          {step < last ? "Next" : questions.length > 1 ? "Send answers" : "Send answer"}
        </Button>
      </div>
    </form>
  );
}

function Question({
  question,
  value,
  onChange,
  onPick,
}: {
  question: InputQuestion;
  value: string;
  onChange(id: string, value: string): void;
  /** A choice was picked, as opposed to typed. */
  onPick?(id: string, value: string): void;
}) {
  const picked = question.options.some((option) => option.label === value);
  const inputId = `request-answer-${question.id}`;
  return (
    <fieldset className="chat-request-question">
      <legend>
        {question.header && question.header !== question.question ? (
          <span className="chat-request-question-header">{question.header}</span>
        ) : null}
        {question.question}
      </legend>
      {question.options.length > 0 ? (
        <div className="chat-request-options">
          {question.options.map((option) => (
            <label key={option.label} className={`chat-request-option${value === option.label ? " is-picked" : ""}`}>
              <input
                className="sr-only"
                type="radio"
                name={inputId}
                checked={value === option.label}
                onChange={() => (onPick ?? onChange)(question.id, option.label)}
              />
              <span>
                <span className="chat-request-option-label">{option.label}</span>
                {option.description ? <span className="chat-request-option-detail">{option.description}</span> : null}
              </span>
              <Icon name="check" size={14} className="chat-request-option-check" />
            </label>
          ))}
        </div>
      ) : null}
      {question.allowOther ? (
        <input
          id={inputId}
          className="input input-sm"
          type={question.secret ? "password" : "text"}
          autoComplete="off"
          aria-label={question.options.length > 0 ? `${question.question}, other answer` : question.question}
          placeholder={question.options.length > 0 ? "Or type your own answer" : "Your answer"}
          value={picked ? "" : value}
          onChange={(event) => onChange(question.id, event.target.value)}
        />
      ) : null}
    </fieldset>
  );
}
