import {
  type BuddyMessage,
  type BuddyProjection,
  buddiesInOrder,
  type RuntimeProjection,
  teamTargets,
} from "@zli-v2/contracts";
import { type FormEvent, useRef, useState } from "react";

import { type MentionOption, useMentionPicker } from "../chat/MentionPicker.js";
import { makeCommandId } from "../runtime/commandId.js";
import { BuddyAvatar } from "../teammates/BuddyAvatar.js";
import { lookOf } from "../teammates/pixelBuddies.js";
import type { Run } from "./useRun.js";
import "./buddyChat.css";

/** The list entry for the team chat, kept apart from buddy ids. */
export const TEAM_CHAT_ID = "team-chat";

export type TeamChatLine =
  | { kind: "you"; key: string; text: string; at: string; to: BuddyProjection[] }
  | { kind: "buddy"; key: string; text: string; at: string; buddy: BuddyProjection | undefined; unanswered: boolean };

/**
 * The team chat as one thread. Each buddy keeps its own copy of the person's message, so the copies show as
 * one line, followed by each buddy's answer under its own name.
 */
export function teamChatLines(projection: RuntimeProjection): TeamChatLine[] {
  const byId = new Map((projection.buddies ?? []).map((buddy) => [buddy.buddyId, buddy]));
  const lines: TeamChatLine[] = [];
  const asked = new Map<string, Extract<TeamChatLine, { kind: "you" }>>();
  for (const message of projection.buddyMessages ?? []) {
    if (!message.team) continue;
    const buddy = byId.get(message.buddyId);
    if (message.role === "you") {
      const line = asked.get(message.team);
      if (line) {
        if (buddy) line.to.push(buddy);
        continue;
      }
      const next = {
        kind: "you" as const,
        key: message.team,
        text: message.text,
        at: message.at,
        to: buddy ? [buddy] : [],
      };
      asked.set(message.team, next);
      lines.push(next);
    } else if (!message.to) {
      lines.push({
        kind: "buddy",
        key: message.messageId,
        text: message.text,
        at: message.at,
        buddy,
        unanswered: message.unanswered === true,
      });
    }
  }
  return lines;
}

/** Buddies still working on a team chat message: a copy with no final answer after it. */
export function teamChatWaiting(projection: RuntimeProjection): BuddyProjection[] {
  const messages = projection.buddyMessages ?? [];
  return buddiesInOrder(projection).filter((buddy) => {
    const own = messages.filter((message: BuddyMessage) => message.buddyId === buddy.buddyId);
    const lastAnswer = own.findLastIndex((message) => message.role === "buddy" && !message.progress);
    return own.slice(lastAnswer + 1).some((message) => message.role === "you" && message.team);
  });
}

export function TeamChat({ projection, run }: { projection: RuntimeProjection; run: Run }) {
  const [draft, setDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const team = buddiesInOrder(projection);
  const options: MentionOption[] = team.map((buddy) => ({
    name: buddy.name,
    buddy: buddy.color,
    provider: "",
    detail: buddy.role === "primary" ? "Primary" : (buddy.title ?? "Buddy"),
  }));
  const mention = useMentionPicker({ draft, setDraft, textareaRef, options });
  const lines = teamChatLines(projection);
  const waiting = teamChatWaiting(projection);
  const goesTo = draft.trim() ? teamTargets(projection, draft) : [];

  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    if (!text) return;
    if (await run({ type: "buddies.team.send", messageId: makeCommandId(), text })) setDraft("");
  };

  return (
    <div className="buddy-chat team-chat">
      <div className="buddy-chat-log" role="log" aria-label="Team chat">
        <div className="buddy-chat-column">
          {lines.length === 0 ? (
            <div className="buddy-chat-empty">
              <h3>Team chat</h3>
              <p>
                Type @ and a name to bring a buddy in. Each one you name answers here. Name nobody and your Primary
                answers.
              </p>
            </div>
          ) : null}
          {lines.map((line) =>
            line.kind === "you" ? (
              <div key={line.key} className="team-chat-line is-you">
                <p className="team-chat-text">{line.text}</p>
                {line.to.length > 0 ? (
                  <span className="team-chat-to">To {line.to.map((buddy) => buddy.name).join(", ")}</span>
                ) : null}
              </div>
            ) : (
              <div key={line.key} className={`team-chat-line is-buddy${line.unanswered ? " is-unanswered" : ""}`}>
                {line.buddy ? (
                  <BuddyAvatar
                    buddy={line.buddy.color}
                    look={lookOf(line.buddy)}
                    image={line.buddy.image}
                    size={28}
                    name={line.buddy.name}
                  />
                ) : null}
                <div className="team-chat-body">
                  <span className="team-chat-name">{line.buddy?.name ?? "A removed buddy"}</span>
                  <p className="team-chat-text">{line.text}</p>
                </div>
              </div>
            ),
          )}
          {waiting.length > 0 ? (
            <p className="team-chat-waiting" aria-live="polite">
              {waiting.map((buddy) => buddy.name).join(", ")} {waiting.length === 1 ? "is" : "are"} answering
            </p>
          ) : null}
        </div>
      </div>
      <form className="buddy-chat-dock team-chat-dock" onSubmit={send}>
        {mention.list}
        <textarea
          ref={textareaRef}
          className="team-chat-input"
          aria-label="Message the team"
          placeholder="Message the team. Type @ to bring a buddy in."
          rows={2}
          value={draft}
          onChange={(event) => {
            setDraft(event.currentTarget.value);
            mention.trackCaret(event);
          }}
          onSelect={mention.trackCaret}
          onKeyDown={(event) => {
            if (mention.onKeyDown(event)) return;
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) void send(event);
          }}
          {...mention.inputProps}
        />
        <div className="team-chat-send">
          <span className="team-chat-to">
            {goesTo.length > 0 ? `Goes to ${goesTo.map((buddy) => buddy.name).join(", ")}` : ""}
          </span>
          <button type="submit" disabled={!draft.trim()}>
            Send
          </button>
        </div>
      </form>
    </div>
  );
}
