import type { AppDraftEmail, ThreadRequestProjection } from "@zli-v2/contracts";
import { useId, useState } from "react";

import { Button } from "../ui/Button.js";
import { AppLogo } from "./ConnectedAppsDialog.js";
import "./appDraft.css";

type Payload = {
  title?: unknown;
  apps?: unknown;
  actions?: unknown;
  details?: unknown;
  email?: Partial<AppDraftEmail>;
};

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * Something a buddy wants to do in the person's apps, held until they decide. An email shows as a draft they
 * can edit before it goes; anything else shows what it would do. It stays until Send or Discard, and ZLI runs it.
 */
export function AppDraftCard({
  request,
  onRespond,
}: {
  request: ThreadRequestProjection;
  onRespond(decision: unknown): Promise<unknown>;
}) {
  const payload = (request.payload ?? {}) as Payload;
  const apps = text(payload.apps) || "Your apps";
  const app = apps.split(",")[0]?.trim().toLowerCase().replace(/\s+/gu, "_") ?? "";
  const [busy, setBusy] = useState(false);
  const answer = async (decision: unknown) => {
    setBusy(true);
    try {
      await onRespond(decision);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="app-draft" aria-label={text(payload.title) || `Waiting for you in ${apps}`}>
      <header className="app-draft-head">
        <AppLogo app={app} size={18} />
        <span>{payload.email ? (app === "gmail" ? "Mail" : apps) : apps}</span>
      </header>
      {payload.email ? (
        <EmailDraft email={payload.email} busy={busy} onAnswer={answer} />
      ) : (
        <ActionDraft payload={payload} busy={busy} onAnswer={answer} />
      )}
    </section>
  );
}

function EmailDraft({
  email,
  busy,
  onAnswer,
}: {
  email: Partial<AppDraftEmail>;
  busy: boolean;
  onAnswer(decision: unknown): Promise<void>;
}) {
  const id = useId();
  const [draft, setDraft] = useState<AppDraftEmail>({
    to: email.to ?? "",
    cc: email.cc ?? "",
    bcc: email.bcc ?? "",
    subject: email.subject ?? "",
    body: email.body ?? "",
  });
  // A hidden copy is shown whenever the buddy added one, so nobody gets the email without the person seeing it.
  const [showBcc] = useState(Boolean(email.bcc));
  const set = (key: keyof AppDraftEmail) => (event: { currentTarget: { value: string } }) =>
    setDraft((current) => ({ ...current, [key]: event.currentTarget.value }));
  const sendable = /\S+@\S+\.\S+/u.test(draft.to) && draft.body.trim().length > 0;
  return (
    <form
      className="app-draft-mail"
      onSubmit={(event) => {
        event.preventDefault();
        if (sendable && !busy) void onAnswer({ approved: true, edits: draft });
      }}
    >
      <input
        className="app-draft-subject"
        aria-label="Subject"
        placeholder="Subject"
        value={draft.subject}
        onChange={set("subject")}
        disabled={busy}
      />
      <label className="app-draft-line" htmlFor={`${id}-to`}>
        <span>To</span>
        <input id={`${id}-to`} type="email" value={draft.to} onChange={set("to")} disabled={busy} required />
      </label>
      <label className="app-draft-line" htmlFor={`${id}-cc`}>
        <span>Cc</span>
        <input id={`${id}-cc`} placeholder="name@example.com" value={draft.cc} onChange={set("cc")} disabled={busy} />
      </label>
      {showBcc ? (
        <label className="app-draft-line" htmlFor={`${id}-bcc`}>
          <span>Bcc</span>
          <input id={`${id}-bcc`} value={draft.bcc} onChange={set("bcc")} disabled={busy} />
        </label>
      ) : null}
      <textarea
        className="app-draft-body"
        aria-label="Message"
        value={draft.body}
        onChange={set("body")}
        disabled={busy}
        rows={Math.min(14, Math.max(4, draft.body.split("\n").length + 1))}
      />
      <footer className="app-draft-foot">
        <span className="app-draft-hint">Edit it here, or ask for changes in the chat.</span>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void onAnswer({ approved: false })}>
          Discard
        </Button>
        <Button type="submit" variant="primary" size="sm" disabled={busy || !sendable}>
          {busy ? "Sending…" : "Send"}
        </Button>
      </footer>
    </form>
  );
}

function ActionDraft({
  payload,
  busy,
  onAnswer,
}: {
  payload: Payload;
  busy: boolean;
  onAnswer(decision: unknown): Promise<void>;
}) {
  const details = text(payload.details);
  return (
    <div className="app-draft-action">
      <strong>{text(payload.title)}</strong>
      {text(payload.actions) ? <p>{text(payload.actions)}</p> : null}
      {details ? <pre>{details}</pre> : null}
      <footer className="app-draft-foot">
        <span className="app-draft-hint">Nothing happens until you allow it.</span>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void onAnswer({ approved: false })}>
          Discard
        </Button>
        <Button variant="primary" size="sm" disabled={busy} onClick={() => void onAnswer({ approved: true })}>
          {busy ? "Working…" : "Allow"}
        </Button>
      </footer>
    </div>
  );
}
