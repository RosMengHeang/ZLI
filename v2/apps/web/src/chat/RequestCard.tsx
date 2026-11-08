import { describeApproval, describeQuestions, type InputQuestion } from "@zli-v2/client-runtime";
import type { ThreadRequestProjection } from "@zli-v2/contracts";
import { useMemo, useState } from "react";

import { Button } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";

export function RequestCard({
  request,
  provider,
  displayName,
  waitingCount,
  onRespond,
  onAnswer,
}: {
  request: ThreadRequestProjection;
  provider: string;
  displayName: string;
  /** Requests from this agent still open, including this one. */
  waitingCount: number;
  onRespond(decision: unknown): Promise<void>;
  onAnswer(answers: Record<string, string>): Promise<void>;
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
          <Icon name={approval ? "shield" : "message"} size={14} />
          {approval ? `${displayName} asks to continue` : `${displayName} has a question`}
        </span>
        {waitingCount > 1 ? <span className="chat-request-count">{waitingCount - 1} more waiting</span> : null}
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
      <details className="chat-request-raw">
        <summary>
          <Icon name="chevronRight" size={12} />
          Full request
        </summary>
        <pre>{JSON.stringify(request.payload, null, 2)}</pre>
      </details>
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
      <div className="chat-request-actions">
        {view.choices.map((choice) => (
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
  const complete = questions.every((question) => (answers[question.id] ?? "").trim().length > 0);
  const set = (id: string, value: string) => setAnswers((current) => ({ ...current, [id]: value }));
  return (
    <form
      className="chat-request-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (complete && !busy) onSubmit(answers);
      }}
    >
      {questions.map((question) => (
        <Question key={question.id} question={question} value={answers[question.id] ?? ""} onChange={set} />
      ))}
      <div className="chat-request-actions">
        <Button type="submit" variant="primary" size="sm" loading={busy} disabled={!complete}>
          {questions.length > 1 ? "Send answers" : "Send answer"}
        </Button>
      </div>
    </form>
  );
}

function Question({
  question,
  value,
  onChange,
}: {
  question: InputQuestion;
  value: string;
  onChange(id: string, value: string): void;
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
            <label key={option.label} className="chat-request-option">
              <input
                type="radio"
                name={inputId}
                checked={value === option.label}
                onChange={() => onChange(question.id, option.label)}
              />
              <span>
                <span className="chat-request-option-label">{option.label}</span>
                {option.description ? <span className="chat-request-option-detail">{option.description}</span> : null}
              </span>
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
