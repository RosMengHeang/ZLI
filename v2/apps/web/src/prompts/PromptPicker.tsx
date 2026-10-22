import { type KeyboardEvent, type ReactNode, useEffect, useId, useMemo, useState } from "react";

import { Icon } from "../ui/Icon.js";
import { insertPrompt, matchPrompts, type SavedPrompt, slashQuery } from "./prompts.js";
import "./prompts.css";

/**
 * Saved prompts for a text box: typing "/" at the start opens the list filtered by what follows,
 * and the button opens it in full. Focus stays in the text box; arrows move, Enter inserts, Escape closes.
 */
export function usePromptPicker({
  draft,
  setDraft,
  prompts,
}: {
  draft: string;
  setDraft(next: string): void;
  prompts: readonly SavedPrompt[];
}) {
  const listId = useId();
  const [browsing, setBrowsing] = useState(false);
  const [dismissedDraft, setDismissedDraft] = useState<string>();
  const [activeIndex, setActiveIndex] = useState(0);
  const query = slashQuery(draft);
  const slashOpen = query !== undefined && dismissedDraft !== draft;
  const open = browsing || slashOpen;
  const matches = useMemo(() => matchPrompts(prompts, slashOpen ? (query ?? "") : ""), [prompts, slashOpen, query]);
  const active = matches[Math.min(activeIndex, matches.length - 1)];

  useEffect(() => {
    if (!open) setActiveIndex(0);
  }, [open]);

  const close = () => {
    setBrowsing(false);
    if (slashOpen) setDismissedDraft(draft);
  };
  const pick = (prompt: SavedPrompt) => {
    setBrowsing(false);
    setDismissedDraft(undefined);
    setDraft(insertPrompt(draft, prompt.prompt));
  };

  /** Returns true when the picker used the key, so the text box should not act on it. */
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): boolean => {
    if (!open) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (matches.length === 0) return true;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((index) => (Math.min(index, matches.length - 1) + step + matches.length) % matches.length);
      return true;
    }
    if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey && active) {
      event.preventDefault();
      pick(active);
      return true;
    }
    if (event.key === "Escape") {
      // Closing the list must not also close the dialog or tile around it.
      event.preventDefault();
      event.stopPropagation();
      close();
      return true;
    }
    return false;
  };

  return {
    open,
    listId,
    matches,
    activeKey: active?.key,
    query: slashOpen ? (query ?? "") : "",
    toggle: () => (open ? close() : setBrowsing(true)),
    close,
    pick,
    onKeyDown,
    setActiveKey: (key: string) =>
      setActiveIndex(
        Math.max(
          0,
          matches.findIndex((entry) => entry.key === key),
        ),
      ),
    /** Combobox wiring for the text box the picker belongs to. */
    inputProps: {
      "aria-autocomplete": "list" as const,
      "aria-controls": open ? listId : undefined,
      "aria-activedescendant": open && active ? `${listId}-${active.key}` : undefined,
    },
  };
}

export type PromptPickerState = ReturnType<typeof usePromptPicker>;

export function PromptList({
  picker,
  emptyHint,
  sharedError,
  footer,
}: {
  picker: PromptPickerState;
  emptyHint: string;
  sharedError?: string | undefined;
  footer?: ReactNode;
}) {
  if (!picker.open) return null;
  const { matches, query } = picker;
  return (
    <div className="prompt-picker">
      <div className="prompt-options" id={picker.listId} role="listbox" aria-label="Saved prompts">
        {matches.length === 0 ? (
          <p className="prompt-empty">{query ? `No saved prompt matches "${query}".` : emptyHint}</p>
        ) : (
          matches.map((entry, index) => {
            const startsGroup = index === 0 || matches[index - 1]?.source !== entry.source;
            return (
              <div key={entry.key}>
                {startsGroup ? (
                  <p className="prompt-group" aria-hidden="true">
                    {entry.source === "shared" ? "Shared in zli.json" : "Personal"}
                  </p>
                ) : null}
                {/* biome-ignore lint/a11y/useKeyWithClickEvents: the text box handles the keyboard for the list. */}
                <div
                  id={`${picker.listId}-${entry.key}`}
                  className={`prompt-option${entry.key === picker.activeKey ? " is-active" : ""}`}
                  role="option"
                  aria-selected={entry.key === picker.activeKey}
                  tabIndex={-1}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseMove={() => picker.setActiveKey(entry.key)}
                  onClick={() => picker.pick(entry)}
                >
                  <span className="prompt-option-name">{entry.name}</span>
                  <span className="prompt-option-text">{entry.prompt}</span>
                </div>
              </div>
            );
          })
        )}
      </div>
      {sharedError ? (
        <p className="prompt-warning" role="status">
          <Icon name="alert" size={12} />
          Shared prompts are unavailable. {sharedError}
        </p>
      ) : null}
      <div className="prompt-footer">
        <span aria-hidden="true">
          <kbd>↑</kbd>
          <kbd>↓</kbd> to move, <kbd>↵</kbd> to insert
        </span>
        {footer}
      </div>
    </div>
  );
}
