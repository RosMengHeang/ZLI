// @vitest-environment jsdom

import { CommandId, EnvironmentId, ProjectId, type RuntimeProjection, type ThreadProjection } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ZliBridge } from "../runtime/bridge.js";
import { RuntimeProvider } from "../runtime/RuntimeProvider.js";
import { ChatView } from "./ChatView.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const projectId = ProjectId.parse("00000000-0000-4000-8000-000000000010");
const worktreeId = "00000000-0000-4000-8000-000000000011";
const threadId = "00000000-0000-4000-8000-000000000401";

const thread = {
  threadId,
  worktreeId,
  provider: "droid",
  status: "waiting",
  activeTurnId: "00000000-0000-4000-8000-000000000501",
  capabilities: {},
  permissionMode: "supervised",
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
    threads: [thread],
    terminals: [],
    browserTabs: [],
    attention: [],
    lastSequence: 1,
    providers: [{ provider: "droid", displayName: "Droid", status: "found", path: "droid" }],
    ...overrides,
  };
}

async function render(projection: RuntimeProjection, onOpenDiff = vi.fn()) {
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
          onOpenDiff={onOpenDiff}
          onRestart={() => undefined}
        />
      </RuntimeProvider>,
    );
  });
  return { container, dispatched, onOpenDiff };
}

const button = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === name || candidate.getAttribute("aria-label") === name,
  );

afterEach(() => document.body.replaceChildren());

describe("ChatView", () => {
  it("shows the turn's work log and changed files, and opens a diff from them", async () => {
    const turnId = thread.activeTurnId as string;
    const { container, onOpenDiff } = await render(
      projectionWith({
        messages: [
          { messageId: "m1", threadId, turnId, role: "user", text: "Rename the helper" },
          { messageId: "m2", threadId, turnId, role: "assistant", text: "Renamed **helper**." },
        ] as RuntimeProjection["messages"],
        activities: [
          { activityId: "a1", threadId, turnId, kind: "command", title: "npm test", status: "completed" },
          {
            activityId: "a2",
            threadId,
            turnId,
            kind: "file-edit",
            title: "Edit src/helper.ts",
            status: "completed",
            files: ["src/helper.ts"],
          },
        ] as RuntimeProjection["activities"],
      }),
    );
    expect(container.querySelector('[aria-label="Work log"]')?.textContent).toContain("npm test");
    const changed = container.querySelector('[aria-label="Changed files"]');
    expect(changed?.textContent).toContain("1 file changed");
    expect(container.querySelector(".markdown strong")?.textContent).toBe("helper");
    await act(async () => button(container, "Open diff")?.click());
    expect(onOpenDiff).toHaveBeenCalledWith();
    await act(async () => changed?.querySelector<HTMLButtonElement>("li button")?.click());
    expect(onOpenDiff).toHaveBeenLastCalledWith("src/helper.ts");
  });

  it("answers an approval request", async () => {
    const { container, dispatched } = await render(
      projectionWith({
        requests: [
          { requestId: "r1", threadId, kind: "approval", payload: { command: "rm -rf build" } },
        ] as unknown as RuntimeProjection["requests"],
      }),
    );
    expect(container.querySelector('[aria-label="Approval request"]')?.textContent).toContain("rm -rf build");
    await act(async () => button(container, "Approve")?.click());
    expect(dispatched.at(-1)?.command).toEqual({
      type: "thread.respond",
      threadId,
      requestId: "r1",
      decision: { approved: true },
    });
  });

  it("sends composer text and shows the session's permission mode", async () => {
    const { container, dispatched } = await render(projectionWith({ threads: [{ ...thread, status: "idle" }] }));
    expect(container.querySelector(".composer-badge")?.textContent).toContain("Supervised");
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Droid"]');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(textarea, "run the tests");
      textarea?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button(container, "Send")?.click());
    expect(dispatched.at(-1)?.command).toEqual({ type: "thread.send", threadId, text: "run the tests" });
  });
});
