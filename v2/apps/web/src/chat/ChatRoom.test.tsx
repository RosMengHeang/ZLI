// @vitest-environment jsdom

import { CommandId, EnvironmentId, ProjectId, type RuntimeProjection, type ThreadProjection } from "@zli-v2/contracts";
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

  it("brings a saved teammate in when the person calls it by name, with the chat so far and its instructions", async () => {
    updateAppSettings((settings) => ({
      ...settings,
      teammates: [
        { id: "t1", name: "Reviewer", buddy: "squircle", provider: "codex", instructions: "Look for missing tests." },
      ],
    }));
    const onBringIn = vi.fn(async () => ({ threadId: guestId }));
    const { container, dispatched } = await render(projectionWith({ messages: roomMessages?.slice(0, 2) }), {
      onBringIn,
    });
    await type(container, "@Reviewer what do you think?");
    await act(async () => button(container, "Send")?.click());
    expect(onBringIn).toHaveBeenCalledWith({ provider: "codex", name: "Reviewer" });
    const sent = dispatched.at(-1)?.command as { threadId: string; context?: string };
    expect(sent.threadId).toBe(guestId);
    expect(sent.context).toContain("You are Reviewer.");
    expect(sent.context).toContain("Look for missing tests.");
    expect(sent.context).toContain("## User\n\nAdd a login page");
  });

  it("brings any installed agent in from the people icon, named after the buddy it wears", async () => {
    const onBringIn = vi.fn(async () => ({ threadId: guestId }));
    const { container } = await render(projectionWith(), { onBringIn });
    // Bring in sits behind the people icon beside the paperclip while the agent is alone in the chat.
    await act(async () => button(container, "Other agents")?.click());
    const bring = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((node) =>
      node.textContent?.includes("Bring in an agent"),
    );
    await act(async () => bring?.click());
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((node) =>
      node.textContent?.includes("Codex"),
    );
    await act(async () => (item as HTMLElement | undefined)?.click());
    // The guest takes a buddy nobody in the chat wears yet, and is named after it.
    const [request] = onBringIn.mock.calls[0] as unknown as [{ provider: string; name: string }];
    expect(request.provider).toBe("codex");
    expect([
      "Gumdrop",
      "Capsule",
      "Plus",
      "Cloud",
      "Mushroom",
      "Peanut",
      "Jelly",
      "Wedge",
      "Squircle",
      "Bulb",
      "House",
      "Bean",
    ]).toContain(request.name);
    expect(container.querySelector("textarea")?.value).toBe(`@${request.name} `);
  });
});
