// @vitest-environment jsdom

import { CommandId, EnvironmentId, ProjectId, type RuntimeProjection, type ThreadProjection } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FileIndexProvider } from "../files/FileIndex.js";
import type { ZliBridge } from "../runtime/bridge.js";
import { RuntimeProvider } from "../runtime/RuntimeProvider.js";
import { ChatView } from "./ChatView.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const projectId = ProjectId.parse("00000000-0000-4000-8000-000000000010");
const worktreeId = "00000000-0000-4000-8000-000000000011";
const threadId = "00000000-0000-4000-8000-000000000401";
const buddyId = "00000000-0000-4000-8000-000000000501";

const projection = {
  environment: {
    environmentId: EnvironmentId.parse("00000000-0000-4000-8000-000000000001"),
    label: "Local",
    protocolVersion: 1,
    capabilities: {},
  },
  projects: [{ projectId, path: "C:/repo", name: "repo" }],
  worktrees: [{ worktreeId, projectId, path: "C:/repo", branch: "main", status: "ready" }],
  threads: [
    { threadId, worktreeId, provider: "droid", status: "idle", capabilities: {}, permissionMode: "supervised" },
  ],
  terminals: [],
  browserTabs: [],
  attention: [],
  lastSequence: 1,
  providers: [{ provider: "droid", displayName: "Droid", status: "found", path: "droid" }],
  buddies: [
    {
      buddyId,
      name: "Reviewer",
      color: "sky",
      title: "Code review",
      role: "buddy",
      order: 0,
      engine: { mode: "auto" },
      permissionMode: "supervised",
      maxActiveJobs: 1,
      handoffs: [],
      memory: [],
      pendingMemory: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
} as unknown as RuntimeProjection;

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

async function render() {
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
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <RuntimeProvider bridge={bridge}>
        <FileIndexProvider onOpenFile={() => undefined}>
          <ChatView
            projection={projection}
            thread={projection.threads[0] as ThreadProjection}
            worktree={projection.worktrees[0]}
            onOpenDiff={() => undefined}
            onRestart={() => undefined}
          />
        </FileIndexProvider>
      </RuntimeProvider>,
    );
  });
  return { container, dispatched };
}

async function type(textarea: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, value);
    textarea.setSelectionRange(value.length, value.length);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(textarea: HTMLTextAreaElement, key: string) {
  await act(async () => {
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

describe("a buddy mentioned in the chat's message box", () => {
  it("is listed under Buddies and gets the message as a job, even when picked mid-sentence", async () => {
    const { container, dispatched } = await render();
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Droid"]');
    if (!textarea) throw new Error("no message box");
    await type(textarea, "check this @rev");
    await vi.waitFor(() => expect(document.querySelector('[role="listbox"]')?.textContent).toContain("Buddies"));
    await press(textarea, "Enter");
    expect(container.querySelector(".composer-chip-label")?.textContent).toBe("Reviewer");
    await press(textarea, "Enter");
    await vi.waitFor(() => expect(dispatched.map((request) => request.command.type)).toContain("task.assign"));
    const assign = dispatched.find((request) => request.command.type === "task.assign")?.command;
    expect(assign?.task).toMatchObject({
      buddyId,
      kind: "job",
      goal: "check this",
      origin: { kind: "chat", threadId },
    });
    expect(dispatched.some((request) => request.command.type === "thread.queue")).toBe(false);
  });
});
