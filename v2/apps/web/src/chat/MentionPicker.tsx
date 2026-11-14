import { agentNameKey } from "@zli-v2/contracts";
import { type KeyboardEvent, type RefObject, useId, useMemo, useState } from "react";

import { BuddyAvatar } from "../teammates/BuddyAvatar.js";
import type { Buddy } from "../teammates/buddies.js";

/** Someone the person can call with @Name: a member of the chat, or a saved teammate who joins when called. */
export type MentionOption = {
  name: string;
  buddy: Buddy;
  provider: string;
  /** Says who it is and whether it is in the chat yet, such as "Codex · in this chat". */
  detail: string;
};

/** The @word the caret sits at the end of, and where it starts. */
function mentionQuery(draft: string, caret: number): { start: number; text: string } | undefined {
  const before = draft.slice(0, caret);
  const match = /(^|\s)@([^\s@]{0,40})$/u.exec(before);
  if (!match) return undefined;
  const text = match[2] ?? "";
  return { start: before.length - text.length - 1, text };
}

/** The list that opens on "@" in the message box. It fills in the name and a space. */
export function useMentionPicker({
  draft,
  setDraft,
  textareaRef,
  options,
}: {
  draft: string;
  setDraft(next: string): void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  options: readonly MentionOption[];
}) {
  const listId = useId();
  const [caret, setCaret] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<string>();
  const query = options.length > 0 ? mentionQuery(draft, caret) : undefined;
  const matches = useMemo(() => {
    if (!query) return [];
    const wanted = agentNameKey(query.text);
    return options.filter((option) => agentNameKey(option.name).startsWith(wanted));
  }, [query, options]);
  const open = matches.length > 0 && dismissedAt !== draft;
  const active = matches[Math.min(activeIndex, matches.length - 1)];

  const pick = (option: MentionOption) => {
    if (!query) return;
    const inserted = `@${option.name} `;
    const next = draft.slice(0, query.start) + inserted + draft.slice(caret).replace(/^\S*/u, "").trimStart();
    setDraft(next);
    const position = query.start + inserted.length;
    setCaret(position);
    setActiveIndex(0);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(position, position);
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || !active || event.nativeEvent.isComposing) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((index) => (index + step + matches.length) % matches.length);
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      pick(active);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setDismissedAt(draft);
      return true;
    }
    return false;
  };

  const trackCaret = (event: { currentTarget: HTMLTextAreaElement }) => {
    setCaret(event.currentTarget.selectionStart ?? event.currentTarget.value.length);
    setActiveIndex(0);
  };

  const list = open ? (
    <div className="prompt-picker mention-picker">
      <div className="prompt-options" id={listId} role="listbox" aria-label="Teammates">
        <p className="prompt-group" aria-hidden="true">
          Call a teammate
        </p>
        {matches.map((option) => (
          // biome-ignore lint/a11y/useKeyWithClickEvents: the text box handles the keyboard for the list.
          <div
            key={option.name}
            id={`${listId}-${agentNameKey(option.name).replace(/\s/gu, "-")}`}
            className={`prompt-option mention-option${option === active ? " is-active" : ""}`}
            role="option"
            aria-selected={option === active}
            tabIndex={-1}
            onMouseDown={(event) => event.preventDefault()}
            onMouseMove={() => setActiveIndex(matches.indexOf(option))}
            onClick={() => pick(option)}
          >
            <BuddyAvatar buddy={option.buddy} provider={option.provider} size={22} />
            <span className="mention-option-copy">
              <span className="prompt-option-name">{option.name}</span>
              <span className="prompt-option-text">{option.detail}</span>
            </span>
          </div>
        ))}
      </div>
      <div className="prompt-footer">
        <span aria-hidden="true">
          <kbd>↑</kbd>
          <kbd>↓</kbd> to move, <kbd>↵</kbd> to call
        </span>
      </div>
    </div>
  ) : null;

  return {
    open,
    list,
    onKeyDown,
    trackCaret,
    inputProps: open
      ? {
          "aria-controls": listId,
          "aria-activedescendant": active ? `${listId}-${agentNameKey(active.name).replace(/\s/gu, "-")}` : undefined,
        }
      : {},
  };
}
