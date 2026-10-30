// @vitest-environment jsdom

import {
  CommandId,
  EnvironmentId,
  ProjectId,
  type RuntimeProjection,
  type TerminalProjection,
  type ThreadProjection,
  type WorktreeProjection,
} from "@zli-v2/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ZliBridge } from "../runtime/bridge.js";
import { RuntimeProvider } from "../runtime/RuntimeProvider.js";
import { registerTerminalModes } from "../terminal/terminalModes.js";
import { DiffView } from "./DiffView.js";
import { ReviewCommentList } from "./ReviewCommentList.js";
import { addReviewComment } from "./reviewComments.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const projectId = ProjectId.parse("00000000-0000-4000-8000-000000000010");
const threadId = "00000000-0000-4000-8000-000000000401";
const terminalId = "00000000-0000-4000-8000-000000000301";

const patch = [
  "diff --git a/src/app.ts b/src/app.ts",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,3 +1,4 @@",
  " export function greet(name: string) {",
  "-  return name;",
  "+  const trimmed = name.trim();",
  "+  return trimmed;",
  " }",
  "",
].join("\n");

let worktreeCounter = 0;
function newWorktree(): WorktreeProjection {
  worktreeCounter += 1;
  return {
    worktreeId: `00000000-0000-4000-8000-0000000001${String(worktreeCounter).padStart(2, "0")}`,
    projectId,
    path: "C:/repo",
    branch: "feature",
    status: "ready",
  } as WorktreeProjection;
}

function projectionFor(
  worktree: WorktreeProjection,
  parts: { threads?: ThreadProjection[]; terminals?: TerminalProjection[] },
): RuntimeProjection {
  return {
    environment: {
      environmentId: EnvironmentId.parse("00000000-0000-4000-8000-000000000001"),
      label: "Local",
      protocolVersion: 1,
      capabilities: {},
    },
    projects: [{ projectId, path: "C:/repo", name: "repo" }],
    worktrees: [worktree],
    threads: parts.threads ?? [],
    terminals: parts.terminals ?? [],
    browserTabs: [],
    attention: [],
    lastSequence: 1,
    providers: [{ provider: "droid", displayName: "Droid", status: "found", path: "droid" }],
  } as RuntimeProjection;
}

async function render(node: React.ReactNode, projection?: RuntimeProjection, rejection?: string) {
  const dispatched: Array<{ command: Record<string, unknown> }> = [];
  const commandId = CommandId.parse("00000000-0000-4000-8000-000000000099");
  const bridge = {
    runtime: {
      dispatch: async (request: { command: Record<string, unknown> }) => {
        if (rejection) return { commandId, accepted: false as const, error: { code: "rejected", message: rejection } };
        dispatched.push(request);
        return { commandId, accepted: true as const };
      },
      getProjection: async () => projection,
      onProjection: () => () => undefined,
      attachTerminal: async () => ({ accepted: true }),
      onTerminal: () => () => undefined,
    },
  } as unknown as ZliBridge;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<RuntimeProvider bridge={bridge}>{node}</RuntimeProvider>);
  });
  return { container, dispatched };
}

const line = (container: HTMLElement, index: number) =>
  container.querySelector<HTMLElement>(`[data-line="${index}"]`) ?? undefined;
const button = (container: ParentNode, name: string) =>
  [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === name || candidate.getAttribute("aria-label") === name,
  );
const key = (target: HTMLElement | undefined | null, init: KeyboardEventInit) =>
  act(async () => {
    target?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
  });
const type = (textarea: HTMLTextAreaElement | null, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, value);
    textarea?.dispatchEvent(new Event("input", { bubbles: true }));
  });

const roots: Root[] = [];

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});

describe("DiffView", () => {
  it("numbers the lines and adds a comment on a range picked with the keyboard", async () => {
    const worktree = newWorktree();
    const { container } = await render(
      <>
        <DiffView worktreeId={worktree.worktreeId} diff={{ path: "src/app.ts", patch }} />
        <ReviewCommentList worktree={worktree} onOpenFile={() => undefined} />
      </>,
    );
    expect(line(container, 1)?.querySelectorAll(".diff-num")[0]?.textContent).toBe("1");
    expect(line(container, 2)?.querySelectorAll(".diff-num")[0]?.textContent).toBe("2");
    expect(line(container, 3)?.querySelectorAll(".diff-num")[1]?.textContent).toBe("2");
    expect(line(container, 0)?.getAttribute("aria-disabled")).toBe("true");

    await act(async () => line(container, 1)?.focus());
    await key(line(container, 1), { key: "ArrowDown" });
    expect(document.activeElement).toBe(line(container, 2));
    await key(line(container, 2), { key: "ArrowDown", shiftKey: true });
    await key(line(container, 3), { key: "ArrowDown", shiftKey: true });
    expect(container.querySelectorAll('[aria-selected="true"]')).toHaveLength(3);
    await key(line(container, 4), { key: "c" });

    const composer = container.querySelector<HTMLTextAreaElement>(".diff-composer textarea");
    expect(container.querySelector(".diff-composer-label")?.textContent).toBe("Comment on src/app.ts:2-3");
    expect(document.activeElement).toBe(composer);
    await type(composer, "Keep the original name in the log.");
    await key(composer, { key: "Enter", ctrlKey: true });

    expect(container.querySelector(".diff-composer")).toBeNull();
    expect(document.activeElement).toBe(line(container, 4));
    expect(container.querySelectorAll(".diff-line.is-commented")).toHaveLength(2);
    const list = container.querySelector('[aria-label="Review comments"]');
    expect(list?.textContent).toContain("1 comment");
    expect(list?.querySelector(".review-comment-location")?.textContent).toBe("src/app.ts:2-3");
    expect(list?.querySelector(".review-comment-excerpt")?.textContent).toBe("-  return name; and 2 more");
    expect(list?.querySelector(".review-comment-body")?.textContent).toBe("Keep the original name in the log.");
  });

  it("picks a range with Shift+click and comments on removed lines in the old file's numbers", async () => {
    const worktree = newWorktree();
    const { container } = await render(
      <DiffView worktreeId={worktree.worktreeId} diff={{ path: "src/app.ts", patch }} />,
    );
    await act(async () => line(container, 2)?.click());
    await key(line(container, 2), { key: "Enter" });
    expect(container.querySelector(".diff-composer-label")?.textContent).toBe(
      "Comment on src/app.ts:2 (before this change)",
    );
    await key(container.querySelector(".diff-composer textarea"), { key: "Escape" });
    expect(container.querySelector(".diff-composer")).toBeNull();

    await act(async () => line(container, 1)?.click());
    await act(async () => {
      line(container, 3)?.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    });
    await act(async () => button(container, "Comment")?.click());
    expect(container.querySelector(".diff-composer-label")?.textContent).toBe("Comment on src/app.ts:1-2");
  });
});

describe("ReviewCommentList", () => {
  const comment = (worktreeId: string, body: string) =>
    addReviewComment({
      worktreeId,
      path: "src/app.ts",
      anchor: { side: "new", start: 2, end: 2 },
      excerpt: ["+  const trimmed = name.trim();"],
      body,
    });

  it("edits and removes comments", async () => {
    const worktree = newWorktree();
    comment(worktree.worktreeId, "First");
    comment(worktree.worktreeId, "Second");
    const { container } = await render(<ReviewCommentList worktree={worktree} onOpenFile={() => undefined} />);
    await act(async () => button(container, "Edit comment on src/app.ts:2")?.click());
    const textarea = container.querySelector<HTMLTextAreaElement>(".review-comment-edit textarea");
    await type(textarea, "First, edited");
    await key(textarea, { key: "Enter", metaKey: true });
    expect(container.querySelector(".review-comment-body")?.textContent).toBe("First, edited");
    await act(async () => button(container, "Remove comment on src/app.ts:2")?.click());
    expect(container.textContent).toContain("1 comment");
    expect(container.querySelector(".review-comment-body")?.textContent).toBe("Second");
  });

  const chat = (worktree: WorktreeProjection) =>
    ({
      threadId,
      worktreeId: worktree.worktreeId,
      provider: "droid",
      status: "idle",
      capabilities: {},
      updatedAt: "2026-01-01T00:00:00.000Z",
    }) as ThreadProjection;
  const agentTerminal = (worktree: WorktreeProjection) =>
    ({
      terminalId,
      worktreeId: worktree.worktreeId,
      title: "Droid",
      status: "running",
      kind: "agent",
      agent: { provider: "droid" },
      lastSequence: 0,
    }) as TerminalProjection;
  const withBracketedPaste = () =>
    registerTerminalModes(terminalId, {
      synced: () => true,
      bracketedPaste: () => true,
      flush: async () => undefined,
    });
  const sendButton = (container: HTMLElement) => button(container, "Send to agent");
  /** Waits for the runtime's agents to load, which the button names in its tooltip once it can send. */
  const waitForTarget = (container: HTMLElement, text: string) =>
    vi.waitFor(() => expect(sendButton(container)?.getAttribute("data-tooltip")).toContain(text));

  it("sends the comments to the only agent in one click and confirms with a way to show it", async () => {
    const worktree = newWorktree();
    comment(worktree.worktreeId, "Rename this.");
    const onShowAgent = vi.fn();
    const onNotice = vi.fn();
    const { container, dispatched } = await render(
      <ReviewCommentList
        worktree={worktree}
        onOpenFile={() => undefined}
        onShowAgent={onShowAgent}
        onNotice={onNotice}
      />,
      projectionFor(worktree, { threads: [chat(worktree)] }),
    );
    await waitForTarget(container, "Send to Droid.");
    await act(async () => sendButton(container)?.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(dispatched.at(-1)?.command).toMatchObject({ type: "thread.queue", threadId });
    expect(String(dispatched.at(-1)?.command.text)).toContain("Rename this.");
    expect(container.querySelector('[aria-label="Review comments"]')).toBeNull();
    expect(onShowAgent).not.toHaveBeenCalled();
    expect(onNotice).toHaveBeenCalledWith({
      message: "Sent to Droid.",
      action: { label: "Show", run: expect.any(Function) },
    });
    onNotice.mock.calls[0]?.[0].action.run();
    expect(onShowAgent).toHaveBeenCalledWith(threadId, "chat");
  });

  it("opens the dialog on Shift+click, sends from it, clears the comments, and shows the agent", async () => {
    const worktree = newWorktree();
    comment(worktree.worktreeId, "Rename this.");
    const onShowAgent = vi.fn();
    const { container, dispatched } = await render(
      <ReviewCommentList worktree={worktree} onOpenFile={() => undefined} onShowAgent={onShowAgent} />,
      projectionFor(worktree, { threads: [chat(worktree)] }),
    );
    await waitForTarget(container, "Send to Droid.");
    await act(async () => {
      sendButton(container)?.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    });
    const dialog = document.querySelector('[role="dialog"][aria-label="Send comments"]');
    expect(dispatched).toHaveLength(0);
    expect(dialog?.querySelector(".choice-detail")?.textContent).toBe("Droid chat · Ready");
    expect(dialog?.querySelector(".send-preview")?.textContent).toContain("src/app.ts:2\n```diff");
    await act(async () => dialog && button(dialog, "Send")?.click());
    expect(dispatched.at(-1)?.command).toMatchObject({ type: "thread.queue", threadId });
    expect(String(dispatched.at(-1)?.command.text)).toContain("Rename this.");
    expect(container.querySelector('[aria-label="Review comments"]')).toBeNull();
    expect(onShowAgent).toHaveBeenCalledWith(threadId, "chat");
  });

  it("pastes into an agent terminal with bracketed paste and without pressing Enter", async () => {
    const worktree = newWorktree();
    comment(worktree.worktreeId, "Check this.");
    const unregister = withBracketedPaste();
    const onShowAgent = vi.fn();
    try {
      const { container, dispatched } = await render(
        <ReviewCommentList worktree={worktree} onOpenFile={() => undefined} onShowAgent={onShowAgent} />,
        projectionFor(worktree, { terminals: [agentTerminal(worktree)] }),
      );
      await waitForTarget(container, "Send to Droid.");
      await act(async () => {
        sendButton(container)?.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
      });
      const dialog = document.querySelector('[role="dialog"][aria-label="Send comments"]');
      await vi.waitFor(() => expect(dialog && button(dialog, "Paste in terminal")).toBeTruthy());
      await act(async () => dialog && button(dialog, "Paste in terminal")?.click());
      const write = dispatched.find((request) => request.command.type === "terminal.write")?.command;
      expect(write?.terminalId).toBe(terminalId);
      const data = String(write?.data);
      expect(data.startsWith("\x1b[200~Please address this review comment")).toBe(true);
      expect(data.endsWith("Check this.\x1b[201~")).toBe(true);
      expect(data).not.toContain("\n");
      expect(onShowAgent).toHaveBeenLastCalledWith(terminalId, "terminal");
    } finally {
      unregister();
    }
  });

  it("pastes into the only agent terminal in one click and says to press Enter there", async () => {
    const worktree = newWorktree();
    comment(worktree.worktreeId, "Check this.");
    const unregister = withBracketedPaste();
    const onShowAgent = vi.fn();
    const onNotice = vi.fn();
    try {
      const { container, dispatched } = await render(
        <ReviewCommentList
          worktree={worktree}
          onOpenFile={() => undefined}
          onShowAgent={onShowAgent}
          onNotice={onNotice}
        />,
        projectionFor(worktree, { terminals: [agentTerminal(worktree)] }),
      );
      await waitForTarget(container, "Send to Droid.");
      await act(async () => sendButton(container)?.click());
      const data = String(dispatched.find((request) => request.command.type === "terminal.write")?.command.data);
      expect(data.startsWith("\x1b[200~Please address this review comment")).toBe(true);
      expect(data.endsWith("Check this.\x1b[201~")).toBe(true);
      // The terminal's view is already mounted, so nothing pulls focus away from the review.
      expect(onShowAgent).not.toHaveBeenCalled();
      expect(onNotice.mock.calls[0]?.[0].message).toBe("Pasted in Droid. Press Enter there to send it.");
      expect(container.querySelector('[aria-label="Review comments"]')).toBeNull();
    } finally {
      unregister();
    }
  });

  it("asks which agent to use when there are several, then sends to the same one in one click", async () => {
    const worktree = newWorktree();
    comment(worktree.worktreeId, "First.");
    const unregister = withBracketedPaste();
    try {
      const { container, dispatched } = await render(
        <ReviewCommentList worktree={worktree} onOpenFile={() => undefined} />,
        projectionFor(worktree, { threads: [chat(worktree)], terminals: [agentTerminal(worktree)] }),
      );
      await waitForTarget(container, "Pick an agent");
      await act(async () => sendButton(container)?.click());
      const dialog = document.querySelector('[role="dialog"][aria-label="Send comments"]');
      expect(dialog?.querySelectorAll('input[type="radio"]')).toHaveLength(2);
      const terminalChoice = [...(dialog?.querySelectorAll<HTMLInputElement>('input[type="radio"]') ?? [])].find(
        (radio) => radio.closest("label")?.textContent?.includes("terminal"),
      );
      await act(async () => terminalChoice?.click());
      await act(async () => dialog && button(dialog, "Paste in terminal")?.click());
      expect(dispatched.at(-1)?.command).toMatchObject({ type: "terminal.write", terminalId });
      expect(container.querySelector('[aria-label="Review comments"]')).toBeNull();

      await act(async () => {
        comment(worktree.worktreeId, "Second.");
      });
      await waitForTarget(container, "Send to Droid.");
      await act(async () => sendButton(container)?.click());
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(dispatched.at(-1)?.command).toMatchObject({ type: "terminal.write", terminalId });
      expect(String(dispatched.at(-1)?.command.data)).toContain("Second.");

      // The arrow sends to another agent, which the next click then uses too.
      await act(async () => {
        comment(worktree.worktreeId, "Third.");
      });
      await act(async () => button(container, "Choose agent")?.click());
      const items = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role^="menuitem"]')];
      expect(items.map((item) => item.textContent)).toEqual(["Droid", "Droid", "Edit message before sending…"]);
      expect(items.find((item) => item.getAttribute("aria-checked") === "true")?.title).toContain("terminal");
      await act(async () => items.find((item) => item.title.includes("chat"))?.click());
      expect(dispatched.at(-1)?.command).toMatchObject({ type: "thread.queue", threadId });
      expect(String(dispatched.at(-1)?.command.text)).toContain("Third.");
      await act(async () => {
        comment(worktree.worktreeId, "Fourth.");
      });
      await act(async () => sendButton(container)?.click());
      expect(dispatched.at(-1)?.command).toMatchObject({ type: "thread.queue", threadId });

      // Editing first opens the dialog on the agent used last.
      await act(async () => {
        comment(worktree.worktreeId, "Fifth.");
      });
      await act(async () => button(container, "Choose agent")?.click());
      const edit = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (item) => item.textContent === "Edit message before sending…",
      );
      await act(async () => edit?.click());
      const checked = document.querySelector<HTMLInputElement>(
        '[aria-label="Send comments"] input[type="radio"]:checked',
      );
      expect(checked?.closest("label")?.textContent).toContain("Droid chat");
    } finally {
      unregister();
    }
  });

  it("keeps the comments and shows why in the dialog when a one-click send fails", async () => {
    const worktree = newWorktree();
    comment(worktree.worktreeId, "Rename this.");
    const { container } = await render(
      <ReviewCommentList worktree={worktree} onOpenFile={() => undefined} />,
      projectionFor(worktree, { threads: [chat(worktree)] }),
      "The agent is not accepting messages.",
    );
    await waitForTarget(container, "Send to Droid.");
    await act(async () => sendButton(container)?.click());
    const dialog = document.querySelector('[role="dialog"][aria-label="Send comments"]');
    expect(dialog?.querySelector('[role="alert"]')?.textContent).toBe("The agent is not accepting messages.");
    expect(container.querySelector('[aria-label="Review comments"]')?.textContent).toContain("1 comment");
  });
  it("only offers agents in the comments' own worktree, even one picked there for something else", async () => {
    const worktree = newWorktree();
    const other = { ...newWorktree(), branch: "cursor-foia" };
    comment(worktree.worktreeId, "Rename this.");
    const projection = projectionFor(worktree, { threads: [chat(other)] });
    projection.worktrees.push(other);
    // Annotations from this worktree went to the agent in the other one last time.
    window.localStorage.setItem("zli.sendTarget.v1", JSON.stringify({ [worktree.worktreeId]: `${threadId}:chat` }));
    const { container, dispatched } = await render(
      <ReviewCommentList worktree={worktree} onOpenFile={() => undefined} />,
      projection,
    );
    await waitForTarget(container, "No agent is running here yet");
    await act(async () => button(container, "Choose agent")?.click());
    expect([...document.querySelectorAll('[role="menu"] [role^="menuitem"]')].map((item) => item.textContent)).toEqual([
      "Edit message before sending…",
    ]);
    await act(async () => button(container, "Choose agent")?.click());
    await act(async () => sendButton(container)?.click());
    const dialog = document.querySelector('[role="dialog"][aria-label="Send comments"]');
    expect(dialog?.querySelector('[role="alert"]')?.textContent).toContain("No agent is running in feature.");
    expect(dialog?.querySelector('input[type="radio"]')).toBeNull();
    expect(dispatched).toHaveLength(0);
    window.localStorage.clear();
  });
});
