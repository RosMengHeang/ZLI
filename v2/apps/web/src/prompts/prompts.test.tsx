// @vitest-environment jsdom

import { CommandId } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { Composer } from "../chat/Composer.js";
import type { ZliBridge } from "../runtime/bridge.js";
import { RuntimeProvider } from "../runtime/RuntimeProvider.js";
import {
  combinePrompts,
  deletePersonalPrompt,
  insertPrompt,
  matchPrompts,
  parsePersonalPrompts,
  savePersonalPrompt,
  slashQuery,
} from "./prompts.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.replaceChildren();
  for (const prompt of parsePersonalPrompts(window.localStorage.getItem("zli.prompts.v1"))) {
    deletePersonalPrompt(prompt.id);
  }
});

describe("saved prompts", () => {
  it("opens the picker only for a leading slash word", () => {
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/rev")).toBe("rev");
    expect(slashQuery("/rev now")).toBeUndefined();
    expect(slashQuery("fix /tmp")).toBeUndefined();
  });

  it("ranks name prefixes before other matches and keeps shared prompts first", () => {
    const prompts = combinePrompts(
      [{ name: "Write tests", prompt: "Add tests that review edge cases." }],
      [
        { id: "a", name: "Code review", prompt: "Check the diff." },
        { id: "b", name: "Review", prompt: "Review it." },
      ],
    );
    expect(prompts.map((entry) => entry.source)).toEqual(["shared", "personal", "personal"]);
    expect(matchPrompts(prompts, "rev").map((entry) => entry.name)).toEqual(["Review", "Code review", "Write tests"]);
    expect(matchPrompts(prompts, "")).toHaveLength(3);
  });

  it("replaces a slash search and appends to other text", () => {
    expect(insertPrompt("/rev", "Review it.")).toBe("Review it.");
    expect(insertPrompt("", "Review it.")).toBe("Review it.");
    expect(insertPrompt("Look at auth.  ", "Review it.")).toBe("Look at auth.\n\nReview it.");
  });

  it("saves, edits, and deletes personal prompts in local storage", () => {
    const saved = savePersonalPrompt({ name: "  Triage ", prompt: "Find the cause." });
    expect(saved.name).toBe("Triage");
    savePersonalPrompt({ id: saved.id, name: "Triage", prompt: "Find the root cause." });
    expect(parsePersonalPrompts(window.localStorage.getItem("zli.prompts.v1"))).toEqual([
      { id: saved.id, name: "Triage", prompt: "Find the root cause." },
    ]);
    deletePersonalPrompt(saved.id);
    expect(parsePersonalPrompts(window.localStorage.getItem("zli.prompts.v1"))).toEqual([]);
    expect(parsePersonalPrompts("not json")).toEqual([]);
    expect(parsePersonalPrompts(JSON.stringify([{ id: 1 }, { id: "x", name: "", prompt: "y" }]))).toEqual([]);
  });

  it("inserts a shared prompt from the composer with / and the keyboard", async () => {
    savePersonalPrompt({ name: "Personal review", prompt: "Mine." });
    const bridge = {
      runtime: {
        dispatch: async (request: { commandId: string; command: { type: string } }) => ({
          commandId: CommandId.parse(request.commandId),
          accepted: true as const,
          ...(request.command.type === "project.config"
            ? {
                result: {
                  status: "valid",
                  config: { version: 1, prompts: [{ name: "Review", prompt: "Review the diff carefully." }] },
                },
              }
            : {}),
        }),
        getProjection: async () => undefined,
        onProjection: () => () => undefined,
      },
    } as unknown as ZliBridge;
    const container = document.createElement("div");
    document.body.append(container);
    await act(async () => {
      createRoot(container).render(
        <RuntimeProvider bridge={bridge}>
          <Composer
            displayName="Droid"
            branch="main"
            disabled={false}
            models={undefined}
            model={undefined}
            modelLocked={false}
            onModelChange={() => undefined}
            permissionMode="full-access"
            projectId="00000000-0000-4000-8000-000000000010"
            onSubmit={async () => true}
          />
        </RuntimeProvider>,
      );
    });
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea") as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, "/rev");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const options = () => [...container.querySelectorAll('[role="option"]')].map((option) => option.textContent);
    expect(options()).toEqual(["ReviewReview the diff carefully.", "Personal reviewMine."]);
    expect(textarea.getAttribute("aria-activedescendant")).toBeTruthy();

    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    });
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(textarea.value).toBe("Review the diff carefully.");
    expect(container.querySelector('[role="listbox"]')).toBeNull();

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, "/");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelector('[role="listbox"]')).not.toBeNull();
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    expect(textarea.value).toBe("/");
  });
});
