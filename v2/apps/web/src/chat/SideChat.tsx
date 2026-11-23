import type { RuntimeProjection, ThreadMessageProjection } from "@zli-v2/contracts";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";

import { useRuntimeSelector } from "../runtime/RuntimeProvider.js";
import { entriesForThread, shallowArrayEqual } from "../runtime/runtimeStore.js";
import { handoffTranscript } from "../sessions/handoff.js";
import { Button, IconButton } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { AssistantMessage, UserMessage, WorkingStatus } from "./ChatMessages.js";
import "./sideChat.css";

/* ---------- What the side agent reads ---------- */

/** How much of the main chat a side question carries. The newest messages are kept when it is longer. */
export const SIDE_CONTEXT_CHAR_BUDGET = 24_000;
/** How much of what the main chat said since the last side answer a follow-up carries. */
export const SIDE_UPDATE_CHAR_BUDGET = 12_000;

const SIDE_RULES =
  "You are answering a quick side question about the chat below. You can read it, but you are not part of it, and nothing you say is added to it. Answer briefly and directly from what you can see. Do not edit files, run commands that change anything, or start the work yourself. If a good answer needs more than a quick look, say so.";

type NameOf = (message: ThreadMessageProjection) => string;

/** The rules and the main chat so far, sent with the first side question. */
export function sideQuestionContext(messages: readonly ThreadMessageProjection[], nameOf: NameOf): string {
  const transcript = handoffTranscript(messages, nameOf, SIDE_CONTEXT_CHAR_BUDGET);
  const chat =
    transcript.included > 0 ? `<main-chat>\n${transcript.text}\n</main-chat>` : "The main chat has no messages yet.";
  return [SIDE_RULES, chat, "The side question:"].join("\n\n");
}

/**
 * What the main chat said after the message with `afterId`, sent with a follow-up so the side agent keeps up.
 * Undefined when nothing new was said, or when `afterId` is gone (the chat was edited), which sends nothing extra.
 */
export function sideQuestionUpdate(
  messages: readonly ThreadMessageProjection[],
  afterId: string | undefined,
  nameOf: NameOf,
): string | undefined {
  const start = afterId === undefined ? 0 : messages.findIndex((message) => message.messageId === afterId) + 1;
  if (start === 0 && afterId !== undefined) return undefined;
  const fresh = messages.slice(start);
  const transcript = handoffTranscript(fresh, nameOf, SIDE_UPDATE_CHAR_BUDGET);
  if (transcript.included === 0) return undefined;
  return [
    "The main chat moved on since your last answer. Its new messages, oldest first:",
    `<main-chat-update>\n${transcript.text}\n</main-chat-update>`,
    "The next side question:",
  ].join("\n\n");
}

/* ---------- The shortcut ---------- */

const requestListeners = new Set<() => void>();

/** Asks the chat in focus to open its side question. The window-wide shortcut calls it. */
export function requestSideQuestion(): void {
  for (const listener of requestListeners) listener();
}

/** Calls `listener` when the side question shortcut is pressed. */
export function onSideQuestionRequest(listener: () => void): () => void {
  requestListeners.add(listener);
  return () => {
    requestListeners.delete(listener);
  };
}

/* ---------- The panel ---------- */

/**
 * A question beside the chat: it reads the conversation but never writes to it. The answer comes from a short
 * read-only chat of its own, shown here and closed with the panel. An answer can be sent to the message box.
 * The thread reads like the main chat: the same bubbles, replies, and working line, in a smaller message box.
 */
export function SideChat({
  threadId,
  starting,
  error,
  onAsk,
  onClose,
  onSendToChat,
}: {
  /** The side chat's thread, once the first question started it. */
  threadId: string | undefined;
  starting: boolean;
  error: string | undefined;
  onAsk(question: string): void;
  onClose(): void;
  /** Puts an answer in the main chat's message box, to edit and send there. */
  onSendToChat?: ((text: string) => void) | undefined;
}) {
  const [draft, setDraft] = useState("");
  const [sentId, setSentId] = useState<string>();
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
  const lastAnswerId = shown.findLast((message) => message.role === "assistant")?.messageId;
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
      <header className="side-chat-head">
        <div className="side-chat-heading">
          <span className="side-chat-title">Side question</span>
          <span className="side-chat-note">Reads this chat. Answers stay out of it.</span>
        </div>
        <IconButton label="Close the side question" tooltip="Close (Esc)" icon="x" size="xs" onClick={onClose} />
      </header>
      {shown.length > 0 || thinking || error ? (
        <div className="side-chat-log" ref={logRef}>
          {shown.map((message) => {
            if (message.role === "user")
              return <UserMessage key={message.messageId} message={message} links={undefined} />;
            // Half an answer is not worth copying or sending, so the one still being written waits.
            const answer = message.text.trim();
            const finished = Boolean(answer) && !(thinking && message.messageId === lastAnswerId);
            return (
              <AssistantMessage
                key={message.messageId}
                message={message}
                links={undefined}
                reply={finished ? answer : undefined}
                actions={
                  onSendToChat ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      className="side-chat-send"
                      onClick={() => {
                        onSendToChat(answer);
                        setSentId(message.messageId);
                      }}
                    >
                      {sentId === message.messageId ? "In the message box" : "Send to chat"}
                    </Button>
                  ) : undefined
                }
              />
            );
          })}
          {thinking ? <WorkingStatus label="Thinking" live /> : null}
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
          placeholder="Ask a side question"
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
        <button
          className="send-button"
          type="submit"
          aria-label="Ask"
          data-tooltip="Ask"
          data-shortcut="Enter"
          aria-keyshortcuts="Enter"
          disabled={!draft.trim() || thinking}
        >
          <Icon name="arrowUp" size={14} />
        </button>
      </form>
    </section>
  );
}

const NO_MESSAGES: readonly ThreadMessageProjection[] = [];
