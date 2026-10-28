// @vitest-environment jsdom

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { cleanupRuntimeRenders, renderWithRuntime, typeInto } from "../review/testRuntime.js";
import { HuddlePane } from "./HuddlePane.js";
import {
  buttonNamed,
  byLabel,
  click,
  coderId,
  helperId,
  huddle,
  huddleId,
  huddleProjection,
  otherHuddleId,
  posts,
  typeInput,
} from "./testHuddles.js";

afterEach(async () => {
  await cleanupRuntimeRenders();
});

const accept = () => ({ result: {} });

async function renderPane(
  projection = huddleProjection(),
  respond: Parameters<typeof renderWithRuntime>[1] = accept,
  handlers: { onSelect?: (id: string) => void; onOpenAgent?: (id: string) => void } = {},
) {
  const onSelect = handlers.onSelect ?? vi.fn();
  const onOpenAgent = handlers.onOpenAgent ?? vi.fn();
  const commands = await renderWithRuntime(
    <HuddlePane projection={projection} selectedId={huddleId} onSelect={onSelect} onOpenAgent={onOpenAgent} />,
    respond,
  );
  return { commands, onSelect, onOpenAgent };
}

const post = (number: number) => {
  const found = document.querySelector(`[aria-label^="Message ${number} from"]`);
  if (!found) throw new Error(`No message ${number}`);
  return found as HTMLElement;
};

describe("HuddlePane", () => {
  it("shows the transcript with kinds, recipients, markers, and delivery reasons", async () => {
    await renderPane();
    expect(document.querySelector('[aria-label="Huddle"]')).not.toBeNull();
    expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Release check");

    const first = post(1);
    expect(first.querySelector(".huddle-post-from")?.textContent).toBe("You");
    expect(first.querySelector(".huddle-post-to")?.textContent).toBe("to everyone");
    expect(first.querySelector(".huddle-kind")?.textContent).toBe("Ask");
    expect(first.querySelector(".huddle-post-text")?.textContent).toBe("Plan the release\nThen report <b>back</b>");
    expect(first.querySelector("b")).toBeNull();
    expect(first.textContent).toContain("Coder: Held while you have unsent typing in this terminal.");
    expect(first.textContent).toContain("Helper: has it, answer not posted yet.");

    const second = post(2);
    expect(second.querySelector(".huddle-post-from")?.textContent).toBe("Helper");
    expect(second.querySelector(".huddle-post-to")?.textContent).toBe("to you");
    expect(second.querySelector(".huddle-kind")?.textContent).toBe("Note");
    expect(second.textContent).toContain("Answer from chat");
    expect(second.textContent).toContain("Cut at 2,000 characters.");

    const third = post(3);
    expect(third.querySelector(".huddle-post-to")?.textContent).toBe("to Helper");
    expect(third.querySelector(".huddle-kind")?.textContent).toBe("Task");
    expect(third.textContent).toContain("Helper: queued. Waiting for the current turn to end.");
    expect(document.querySelector('[aria-label="Decisions"]')?.textContent).toContain("#3");
  });

  it("lists members with kind, status, and held count, and removes one", async () => {
    const { commands } = await renderPane();
    const members = byLabel<HTMLUListElement>("Members");
    expect(members.textContent).toContain("Helper");
    expect(members.textContent).toContain("chat, ready");
    expect(members.textContent).toContain("terminal, running");
    expect(members.textContent).toContain("1 held");
    await click(byLabel("Remove Coder from the huddle"));
    expect(commands).toContainEqual({ type: "huddle.leave", huddleId, agentId: coderId });
  });

  it("opens the agent's chat for an answer that was cut", async () => {
    const { onOpenAgent } = await renderPane();
    await click(buttonNamed("Open chat", post(2)));
    expect(onOpenAgent).toHaveBeenCalledWith(helperId);
  });

  it("sends a message to everyone with Send and to one agent with Ctrl+Enter", async () => {
    const { commands } = await renderPane();
    const textarea = byLabel<HTMLTextAreaElement>("Message to the huddle");
    expect(buttonNamed("Send").disabled).toBe(true);
    await typeInto(textarea, "  Who owns the docs?  ");
    await click(buttonNamed("Send"));
    expect(commands.at(-1)).toMatchObject({
      type: "huddle.post",
      huddleId,
      to: "everyone",
      kind: "ask",
      text: "Who owns the docs?",
    });
    expect(String(commands.at(-1)?.postId)).toMatch(/^[0-9a-f-]{36}$/u);
    expect(textarea.value).toBe("");

    await click(document.querySelector('[aria-label^="Send to"]'));
    await click([...document.querySelectorAll('[role="option"]')].find((option) => option.textContent === "Coder"));
    await click(document.querySelector('[aria-label^="Message kind"]'));
    await click(
      [...document.querySelectorAll('[role="option"]')].find((option) => option.textContent?.startsWith("Task")),
    );
    await typeInto(textarea, "Write the tests");
    const sent = commands.length;
    await pressEnter(textarea, { shiftKey: true });
    expect(commands).toHaveLength(sent);
    await pressEnter(textarea);
    expect(commands.at(-1)).toMatchObject({
      type: "huddle.post",
      to: [coderId],
      kind: "assign",
      text: "Write the tests",
    });
  });

  it("shows why a message was refused next to the composer", async () => {
    await renderPane(huddleProjection(), (command) =>
      command.type === "huddle.post" ? { error: "The huddle is archived." } : { result: {} },
    );
    await typeInto(byLabel<HTMLTextAreaElement>("Message to the huddle"), "Hello");
    await click(buttonNamed("Send"));
    expect(document.querySelector(".huddle-composer [role=alert]")?.textContent).toBe("The huddle is archived.");
  });

  it("explains why the composer is off when the huddle has no members", async () => {
    await renderPane(huddleProjection({ huddles: [huddle({ members: [] })], huddlePosts: [] }));
    expect(byLabel<HTMLTextAreaElement>("Message to the huddle").disabled).toBe(true);
    expect(buttonNamed("Send").disabled).toBe(true);
    expect(byLabel<HTMLTextAreaElement>("Message to the huddle").placeholder).toBe("Add an agent to the huddle first.");
  });

  it("shows the paused bar and resumes", async () => {
    const { commands } = await renderPane(huddleProjection({ huddles: [huddle({ paused: true, agentStreak: 13 })] }));
    expect(document.body.textContent).toContain(
      "Paused after 12 agent messages in a row. Agent messages wait until you write or resume.",
    );
    await click(buttonNamed("Resume"));
    expect(commands).toContainEqual({ type: "huddle.resume", huddleId });
  });

  it("pins and unpins decisions", async () => {
    const { commands } = await renderPane();
    await click(buttonNamed("Pin as decision", post(1)));
    expect(commands).toContainEqual({ type: "huddle.decide", huddleId, postId: posts[0]?.postId, decision: true });
    await click(buttonNamed("Unpin decision", post(3)));
    expect(commands).toContainEqual({ type: "huddle.decide", huddleId, postId: posts[2]?.postId, decision: false });
  });

  it("creates a huddle from the inline name field and cancels with Escape", async () => {
    const onSelect = vi.fn();
    const { commands } = await renderPane(huddleProjection(), accept, { onSelect });
    await click(buttonNamed("New huddle"));
    const input = byLabel<HTMLInputElement>("Huddle name");
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.querySelector('[aria-label="Huddle name"]')).toBeNull();

    await click(buttonNamed("New huddle"));
    await click(buttonNamed("Create"));
    expect(document.querySelector(".huddle-create [role=alert]")?.textContent).toBe("Give the huddle a name.");
    await typeInput(byLabel<HTMLInputElement>("Huddle name"), "Docs");
    await click(buttonNamed("Create"));
    const created = commands.find((command) => command.type === "huddle.create");
    expect(created).toMatchObject({ type: "huddle.create", name: "Docs" });
    expect(onSelect).toHaveBeenCalledWith(created?.huddleId);
  });

  it("moves between huddle tabs with the arrow keys", async () => {
    const onSelect = vi.fn();
    await renderPane(
      huddleProjection({ huddles: [huddle(), huddle({ huddleId: otherHuddleId, name: "Docs" } as never)] }),
      accept,
      { onSelect },
    );
    const tabs = document.querySelectorAll('[role="tab"]');
    expect(tabs).toHaveLength(2);
    expect(tabs[1]?.getAttribute("tabindex")).toBe("-1");
    await act(async () => {
      tabs[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledWith(otherHuddleId);
  });

  it("explains huddles when there are none", async () => {
    await renderPane(huddleProjection({ huddles: [], huddlePosts: [] }));
    expect(document.body.textContent).toContain("No huddles yet");
    expect(document.body.textContent).toContain("dragging a tile header here");
  });

  it("adds an agent dropped from a tile header", async () => {
    const { commands } = await renderPane(huddleProjection({ huddles: [huddle({ members: [] })], huddlePosts: [] }));
    const pane = byLabel<HTMLElement>("Huddle");
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: { types: ["application/x-zli-huddle-agent"], getData: () => helperId },
    });
    await act(async () => {
      pane.dispatchEvent(drop);
    });
    expect(commands).toContainEqual({ type: "huddle.join", huddleId, agentId: helperId });
  });
});

async function pressEnter(target: HTMLElement, init: KeyboardEventInit = {}): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, ...init }));
  });
}
