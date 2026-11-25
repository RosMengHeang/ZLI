// @vitest-environment jsdom

import {
  type BuddyProjection,
  CommandId,
  EnvironmentId,
  ProjectId,
  type RuntimeProjection,
  type ThreadProjection,
} from "@zli-v2/contracts";
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ZliBridge } from "../runtime/bridge.js";
import { RuntimeProvider } from "../runtime/RuntimeProvider.js";
import { DEFAULT_SETTINGS, updateAppSettings } from "../settings/appSettings.js";
import { ChatView } from "./ChatView.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const projectId = ProjectId.parse("00000000-0000-4000-8000-000000000010");
const worktreeId = "00000000-0000-4000-8000-000000000011";
const hostId = "00000000-0000-4000-8000-000000000401";
const guestId = "00000000-0000-4000-8000-000000000402";

const host = {
  threadId: hostId,
  worktreeId,
  provider: "claude-code",
  status: "idle",
  capabilities: {},
} as ThreadProjection;
const guest = {
  threadId: guestId,
  worktreeId,
  provider: "codex",
  status: "idle",
  capabilities: {},
  name: "Owl",
  joins: hostId,
  startedBy: hostId,
} as ThreadProjection;
const reviewer: BuddyProjection = {
  buddyId: "b-reviewer",
  name: "Reviewer",
  color: "paper",
  role: "buddy",
  order: 1,
  engine: { mode: "prefer", provider: "codex" },
  instructions: "Look for missing tests.",
  permissionMode: "read-only",
  maxActiveJobs: 2,
  handoffs: [],
  memory: [{ noteId: "n1", text: "Prefers small PRs.", source: "you", at: "2026-11-15T08:00:00.000Z" }],
  pendingMemory: [],
  createdAt: "2026-11-15T08:00:00.000Z",
  updatedAt: "2026-11-15T08:00:00.000Z",
};

function projectionWith(overrides: Partial<RuntimeProjection> = {}): RuntimeProjection {
  return {
    environment: {
      environmentId: EnvironmentId.parse("00000000-0000-4000-8000-000000000001"),
      label: "Local",
      protocolVersion: 1,
      capabilities: {},
    },
    projects: [{ projectId, path: "C:/repo", name: "repo" }],
    worktrees: [
      { worktreeId, projectId, path: "C:/repo", branch: "main", status: "ready" },
    ] as RuntimeProjection["worktrees"],
    threads: [host],
    terminals: [],
    browserTabs: [],
    attention: [],
    lastSequence: 1,
    providers: [
      { provider: "claude-code", displayName: "Claude Code", status: "found", path: "claude" },
      { provider: "codex", displayName: "Codex", status: "found", path: "codex" },
    ],
    ...overrides,
  };
}

async function render(projection: RuntimeProjection, props: Partial<ComponentProps<typeof ChatView>> = {}) {
  const dispatched: Array<{ command: Record<string, unknown> }> = [];
  const bridge = {
    runtime: {
      dispatch: async (request: { command: Record<string, unknown> }) => {
        dispatched.push(request);
        return { commandId: CommandId.parse("00000000-0000-4000-8000-000000000099"), accepted: true as const };
      },
      getProjection: async () => projection,
      onProjection: () => () => undefined,
      attachTerminal: async () => ({ accepted: true }),
      onTerminal: () => () => undefined,
    },
  } as unknown as ZliBridge;
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    createRoot(container).render(
      <RuntimeProvider bridge={bridge}>
        <ChatView
          projection={projection}
          thread={projection.threads[0] as ThreadProjection}
          worktree={projection.worktrees[0]}
          onOpenDiff={() => undefined}
          onRestart={() => undefined}
          {...props}
        />
      </RuntimeProvider>,
    );
  });
  return { container, dispatched };
}

const button = (root: ParentNode, name: string) =>
  [...root.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === name || candidate.getAttribute("aria-label") === name,
  );

async function type(container: HTMLElement, text: string) {
  const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(textarea, text);
    textarea?.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const chipLabels = () =>
  [...document.querySelectorAll<HTMLElement>(".composer-chip-label")].map((chip) => chip.textContent);

/** Opens "Ask an agent" from the message box's + menu. */
async function openAskMenu(container: HTMLElement) {
  await act(async () => button(container, "Add")?.click());
  const ask = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((node) =>
    node.textContent?.includes("Ask an agent"),
  );
  await act(async () => ask?.click());
}

const menuChoice = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"]')].find((node) =>
    node.textContent?.includes(label),
  );

afterEach(() => {
  document.body.replaceChildren();
  updateAppSettings(() => structuredClone(DEFAULT_SETTINGS));
});

describe("ChatView with more than one agent", () => {
  const roomMessages = [
    { messageId: "m1", threadId: hostId, role: "user", text: "Add a login page" },
    { messageId: "m2", threadId: hostId, turnId: "t1", role: "assistant", text: "Added login.ts." },
    { messageId: "m3", threadId: guestId, role: "user", text: "@Owl review it" },
    { messageId: "m4", threadId: guestId, turnId: "t2", role: "assistant", text: "Found 2 bugs in login.ts." },
  ] as RuntimeProjection["messages"];

  it("shows a brought-in agent's replies in the chat, in order, under its name", async () => {
    const { container } = await render(projectionWith({ threads: [host, guest], messages: roomMessages }));
    const text = container.textContent ?? "";
    expect(text.indexOf("Added login.ts.")).toBeLessThan(text.indexOf("Found 2 bugs"));
    const speakers = [...container.querySelectorAll(".room-speaker-name")].map((node) => node.textContent);
    expect(speakers).toEqual(["Claude Code", "Owl"]);
    expect(container.querySelector('[aria-label="Who is in this chat"]')?.textContent).toContain("Owl");
  });

  it("sends a plain message to the chat's agent with what the guest said, and @Owl to the guest", async () => {
    const { container, dispatched } = await render(projectionWith({ threads: [host, guest], messages: roomMessages }));
    await type(container, "Fix what Owl found");
    await act(async () => button(container, "Send")?.click());
    const toHost = dispatched.at(-1)?.command as { threadId: string; context?: string };
    expect(toHost.threadId).toBe(hostId);
    expect(toHost.context).toContain("Since your last reply");
    expect(toHost.context).toContain("## Owl\n\nFound 2 bugs in login.ts.");

    await type(container, "@Owl check again");
    await act(async () => button(container, "Send")?.click());
    const toGuest = dispatched.at(-1)?.command as { threadId: string; text: string };
    expect(toGuest.threadId).toBe(guestId);
    expect(toGuest.text).toBe("@Owl check again");
  });

  it("brings a buddy in from the + menu, on its own agent", async () => {
    const onBringIn = vi.fn(async () => ({ threadId: guestId }));
    const { container } = await render(projectionWith({ buddies: [reviewer] }), { onBringIn });
    await openAskMenu(container);
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (node) => node.textContent === "Reviewer",
    );
    await act(async () => item?.click());
    expect(onBringIn).toHaveBeenCalledWith({
      provider: "codex",
      name: "Reviewer",
      mode: "ask",
      permissionMode: "read-only",
    });
    // The newcomer goes in as a chip the person can remove, not as loose text.
    expect(chipLabels()).toEqual(["Reviewer"]);
    expect(container.querySelector("textarea")?.value).toBe("");
  });

  it("gives a buddy in the chat its instructions and what it remembers", async () => {
    const joined = { ...guest, name: "Reviewer" } as ThreadProjection;
    const { container, dispatched } = await render(
      projectionWith({ threads: [host, joined], buddies: [reviewer], messages: roomMessages?.slice(0, 2) }),
      { onBringIn: vi.fn(async () => ({ threadId: guestId })) },
    );
    await type(container, "@Reviewer what do you think?");
    await act(async () => button(container, "Send")?.click());
    const sent = dispatched.at(-1)?.command as { type: string; threadId: string; context?: string };
    expect(sent.type).toBe("thread.queue");
    expect(sent.threadId).toBe(guestId);
    expect(sent.context).toContain("Look for missing tests.");
    expect(sent.context).toContain("- Prefers small PRs.");
  });

  it("brings any installed agent in from the + menu, named after the buddy it wears", async () => {
    const onBringIn = vi.fn(async () => ({ threadId: guestId }));
    const { container } = await render(projectionWith(), { onBringIn });
    // Ask an agent sits in the message box's + menu while the agent is alone in the chat.
    await openAskMenu(container);
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((node) =>
      node.textContent?.includes("Codex"),
    );
    await act(async () => (item as HTMLElement | undefined)?.click());
    // The guest takes a color nobody in the chat wears yet, and is named after it.
    const [request] = onBringIn.mock.calls[0] as unknown as [{ provider: string; name: string }];
    expect(request.provider).toBe("codex");
    expect([
      "Sky",
      "Indigo",
      "Orchid",
      "Rose",
      "Tomato",
      "Tangerine",
      "Butter",
      "Lime",
      "Jade",
      "Clay",
      "Paper",
      "Slate",
    ]).toContain(request.name);
    expect(chipLabels()).toEqual([request.name]);
  });
});

describe("Ask and Work", () => {
  const copyId = "00000000-0000-4000-8000-000000000012";
  const worker = { ...guest, worktreeId: copyId, permissionMode: "full-access" } as ThreadProjection;
  const asker = { ...guest, permissionMode: "read-only" } as ThreadProjection;
  const withCopy = (overrides: Partial<RuntimeProjection> = {}) =>
    projectionWith({
      threads: [host, worker],
      worktrees: [
        { worktreeId, projectId, path: "C:/repo", branch: "main", status: "ready" },
        { worktreeId: copyId, projectId, path: "C:/repo-worktrees/main-owl", branch: "main-owl", status: "ready" },
      ] as RuntimeProjection["worktrees"],
      ...overrides,
    });
  const review = {
    worktreeId: copyId,
    baseRef: "main",
    branch: "main-owl",
    state: "changes",
    files: [
      {
        path: "src/login.ts",
        kind: "modified",
        staged: false,
        unstaged: true,
        additions: 12,
        deletions: 3,
        binary: false,
      },
    ],
    conflictFiles: [],
    updatedAt: "2026-11-20T10:00:00.000Z",
  } as unknown as NonNullable<RuntimeProjection["reviews"]>[number];
  const commandsOf = (dispatched: Array<{ command: Record<string, unknown> }>) =>
    dispatched.map((entry) => entry.command);

  it("asks by default, and picking Work brings the agent in to work on a copy", async () => {
    const onBringIn = vi.fn(async () => ({ threadId: guestId }));
    const { container } = await render(projectionWith(), { onBringIn });
    await openAskMenu(container);
    expect(menuChoice("Ask, read only")?.getAttribute("aria-checked")).toBe("true");
    expect(menuChoice("Work on a copy")?.getAttribute("aria-checked")).toBe("false");
    await act(async () => menuChoice("Work on a copy")?.click());
    // The menu stays open with the same agents, now set to work.
    expect(menuChoice("Work on a copy")?.getAttribute("aria-checked")).toBe("true");
    const codex = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((node) =>
      node.textContent?.includes("Codex"),
    );
    expect(codex?.getAttribute("title")).toMatch(/Works on main-[a-z]+, on Codex/u);
    await act(async () => codex?.click());
    const [request] = onBringIn.mock.calls[0] as unknown as [{ provider: string; mode: string }];
    expect(request).toMatchObject({ provider: "codex", mode: "work" });
  });

  it("offers only Ask in a folder without Git", async () => {
    const { container } = await render(
      projectionWith({
        projects: [{ projectId, path: "C:/repo", name: "repo", git: false }] as RuntimeProjection["projects"],
      }),
      { onBringIn: vi.fn(async () => ({ threadId: guestId })) },
    );
    await openAskMenu(container);
    expect(menuChoice("Ask, read only")).toBeDefined();
    expect(menuChoice("Work on a copy")).toBeUndefined();
  });

  it("badges each guest with how it joined", async () => {
    const { container } = await render(withCopy());
    expect(container.querySelector(".room-person-mode")?.textContent).toBe("Work");
    document.body.replaceChildren();
    const asked = await render(projectionWith({ threads: [host, asker] }));
    expect(asked.container.querySelector(".room-person-mode")?.textContent).toBe("Ask");
  });

  it("tells an Ask guest it is read-only, and a Work guest that it works on a copy", async () => {
    const asked = await render(projectionWith({ threads: [host, asker] }));
    await type(asked.container, "@Owl look at login.ts");
    await act(async () => button(asked.container, "Send")?.click());
    const toAsker = asked.dispatched.at(-1)?.command as { context?: string } | undefined;
    expect(toAsker?.context).toContain("your access is read-only");
    document.body.replaceChildren();

    const working = await render(withCopy());
    await type(working.container, "@Owl fix login.ts");
    await act(async () => button(working.container, "Send")?.click());
    const sent = working.dispatched.filter((entry) => entry.command.type === "thread.queue").at(-1)?.command as {
      threadId: string;
      context?: string;
    };
    expect(sent.threadId).toBe(guestId);
    expect(sent.context).toContain("You work on a copy: your own worktree on branch main-owl, made from main.");
  });

  it("shows a Work guest's changes in a card, and merges them into the chat's branch", async () => {
    const { container, dispatched } = await render(withCopy({ reviews: [review] }));
    expect(commandsOf(dispatched)).toContainEqual({ type: "review.refresh", worktreeId: copyId, baseRef: "main" });
    const card = container.querySelector<HTMLElement>(`[aria-label="Owl's copy"]`) as HTMLElement;
    expect(card.textContent).toContain("main-owl");
    expect(card.textContent).toContain("src/login.ts");
    await act(async () => button(card, "src/login.ts+12−3")?.click());
    expect(commandsOf(dispatched)).toContainEqual({ type: "review.diff", worktreeId: copyId, path: "src/login.ts" });
    await act(async () => button(card, "Merge into my branch")?.click());
    expect(commandsOf(dispatched)).toContainEqual({
      type: "review.merge",
      worktreeId: copyId,
      targetRef: "main",
      commitMessage: "Work from Owl",
    });
  });

  it("discards a Work guest's copy after asking", async () => {
    const onDiscardGuest = vi.fn(async () => undefined);
    const { container } = await render(withCopy({ reviews: [review] }), { onDiscardGuest });
    const card = container.querySelector<HTMLElement>(`[aria-label="Owl's copy"]`) as HTMLElement;
    await act(async () => button(card, "Discard")?.click());
    expect(card.textContent).toContain("Discard Owl's copy and its branch?");
    expect(onDiscardGuest).not.toHaveBeenCalled();
    await act(async () => button(card, "Discard")?.click());
    expect(onDiscardGuest).toHaveBeenCalledWith(guestId);
  });

  it("puts a removable chip in the message box from Message Owl on the chip", async () => {
    const { container } = await render(projectionWith({ threads: [host, guest] }));
    await act(async () => button(container, "Owl, Codex")?.click());
    const message = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (node) => node.textContent === "Message Owl",
    );
    await act(async () => message?.click());
    expect(chipLabels()).toEqual(["Owl"]);
    expect(container.querySelector("textarea")?.value).toBe("");
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Remove Owl"]')?.click());
    expect(chipLabels()).toEqual([]);
  });

  it("lists agents in other chats of the project under @, and sends to them in their own chat", async () => {
    const other = {
      threadId: "00000000-0000-4000-8000-000000000403",
      worktreeId,
      provider: "codex",
      status: "idle",
      capabilities: {},
      name: "Fox",
    } as ThreadProjection;
    const { container, dispatched } = await render(projectionWith({ threads: [host, other] }));
    await type(container, "@Fox can you check the login flow?");
    await act(async () => button(container, "Send")?.click());
    expect(dispatched.at(-1)?.command).toMatchObject({
      type: "thread.a2a",
      sourceThreadId: hostId,
      targetThreadId: other.threadId,
      text: "can you check the login flow?",
    });
  });
});
