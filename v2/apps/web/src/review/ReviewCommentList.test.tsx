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

async function render(node: React.ReactNode, projection?: RuntimeProjection) {
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

  it("sends the comments to the chosen chat agent, clears them, and shows the agent", async () => {
    const worktree = newWorktree();
    comment(worktree.worktreeId, "Rename this.");
    const projection = projectionFor(worktree, {
      threads: [
        {
          threadId,
          worktreeId: worktree.worktreeId,
          provider: "droid",
          status: "idle",
          capabilities: {},
          updatedAt: "2026-01-01T00:00:00.000Z",
        } as ThreadProjection,
      ],
    });
    const onShowAgent = vi.fn();
    const { container, dispatched } = await render(
      <ReviewCommentList worktree={worktree} onOpenFile={() => undefined} onShowAgent={onShowAgent} />,
      projection,
    );
    await act(async () => button(container, "Send to agent")?.click());
    const dialog = document.querySelector('[role="dialog"][aria-label="Send comments"]');
    await vi.waitFor(() => expect(dialog?.querySelector('input[type="radio"]')).not.toBeNull());
    expect(dialog?.querySelector(".choice-detail")?.textContent).toBe("Droid chat · Ready");
    expect(dialog?.querySelector(".send-preview")?.textContent).toContain("src/app.ts:2\n```diff");
    await act(async () => dialog && button(dialog, "Send")?.click());
    expect(dispatched.at(-1)?.command).toMatchObject({ type: "thread.send", threadId });
    expect(String(dispatched.at(-1)?.command.text)).toContain("Rename this.");
    expect(container.querySelector('[aria-label="Review comments"]')).toBeNull();
    expect(onShowAgent).toHaveBeenCalledWith(threadId, "chat");
  });

  it("pastes into an agent terminal with bracketed paste and without pressing Enter", async () => {
    const worktree = newWorktree();
    comment(worktree.worktreeId, "Check this.");
    const projection = projectionFor(worktree, {
      terminals: [
        {
          terminalId,
          worktreeId: worktree.worktreeId,
          title: "Droid",
          status: "running",
          kind: "agent",
          agent: { provider: "droid" },
          lastSequence: 0,
        } as TerminalProjection,
      ],
    });
    const unregister = registerTerminalModes(terminalId, {
      synced: () => true,
      bracketedPaste: () => true,
      flush: async () => undefined,
    });
    const onShowAgent = vi.fn();
    try {
      const { container, dispatched } = await render(
        <ReviewCommentList worktree={worktree} onOpenFile={() => undefined} onShowAgent={onShowAgent} />,
        projection,
      );
      await act(async () => button(container, "Send to agent")?.click());
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
});
