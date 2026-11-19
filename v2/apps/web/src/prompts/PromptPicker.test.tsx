// @vitest-environment jsdom

import { act, type KeyboardEvent } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import type { SavedPrompt } from "./prompts.js";
import { type PromptPickerState, usePromptPicker } from "./PromptPicker.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.replaceChildren();
});

const prompts: SavedPrompt[] = [{ key: "review", name: "review", prompt: "Review this change.", source: "personal" }];

function keyEvent(key: string, isComposing: boolean) {
  let prevented = false;
  const event = {
    key,
    shiftKey: false,
    nativeEvent: { isComposing },
    preventDefault: () => {
      prevented = true;
    },
    stopPropagation: () => {},
  } as unknown as KeyboardEvent<HTMLElement>;
  return { event, prevented: () => prevented };
}

function mount(draft: string) {
  const state: { picker?: PromptPickerState; draft: string } = { draft };
  function Probe() {
    state.picker = usePromptPicker({
      draft,
      setDraft: (next) => {
        state.draft = next;
      },
      prompts,
    });
    return null;
  }
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(<Probe />));
  return state;
}

describe("prompt picker keys", () => {
  it("leaves Enter and Escape to the IME while composing", () => {
    const state = mount("/rev");
    for (const key of ["Enter", "Escape", "ArrowDown"]) {
      const { event, prevented } = keyEvent(key, true);
      let used = true;
      act(() => {
        used = state.picker!.onKeyDown(event);
      });
      expect(used).toBe(false);
      expect(prevented()).toBe(false);
    }
    expect(state.draft).toBe("/rev");
    expect(state.picker!.open).toBe(true);
  });

  it("inserts the highlighted prompt on Enter once composing ends", () => {
    const state = mount("/rev");
    const { event } = keyEvent("Enter", false);
    let used = false;
    act(() => {
      used = state.picker!.onKeyDown(event);
    });
    expect(used).toBe(true);
    expect(state.draft).toContain("Review this change.");
  });
});
