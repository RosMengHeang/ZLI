import {
  HUDDLE_TYPING_REASON,
  type HuddlePost,
  type HuddleProjection,
  ProjectId,
  type RuntimeProjection,
  type TerminalProjection,
  type ThreadProjection,
  WorktreeId,
} from "@zli-v2/contracts";
import { act } from "react";

export const projectId = ProjectId.parse("00000000-0000-4000-8000-000000000010");
export const worktreeId = WorktreeId.parse("00000000-0000-4000-8000-000000000101");
export const helperId = "00000000-0000-4000-8000-000000000201";
export const coderId = "00000000-0000-4000-8000-000000000301";
export const huddleId = "00000000-0000-4000-8000-000000000501";
export const otherHuddleId = "00000000-0000-4000-8000-000000000502";

export const helper = {
  threadId: helperId,
  sessionId: "session-helper",
  worktreeId,
  provider: "codex",
  name: "Helper",
  status: "idle",
  createdAt: "2026-01-01T10:00:00.000Z",
  updatedAt: "2026-01-01T10:00:00.000Z",
} as unknown as ThreadProjection;

export const coder = {
  terminalId: coderId,
  sessionId: "session-coder",
  worktreeId,
  title: "Claude",
  name: "Coder",
  status: "running",
  kind: "agent",
  agent: { provider: "claude" },
  createdAt: "2026-01-01T10:00:00.000Z",
} as unknown as TerminalProjection;

export function huddle(overrides: Partial<HuddleProjection> = {}): HuddleProjection {
  return {
    huddleId,
    name: "Release check",
    members: [
      { agentId: helperId, kind: "chat", joinedAt: "2026-01-01T10:00:00.000Z" },
      { agentId: coderId, kind: "terminal", joinedAt: "2026-01-01T10:00:00.000Z" },
    ],
    createdAt: "2026-01-01T10:00:00.000Z",
    updatedAt: "2026-01-01T10:00:00.000Z",
    agentTurns: 0,
    nextNumber: 4,
    ...overrides,
  } as HuddleProjection;
}

export const posts: HuddlePost[] = [
  {
    postId: "00000000-0000-4000-8000-000000000601",
    huddleId,
    number: 1,
    from: { kind: "person" },
    to: "everyone",
    kind: "ask",
    text: "Plan the release\nThen report <b>back</b>",
    createdAt: "2026-01-01T10:01:00.000Z",
    deliveries: [
      { agentId: helperId, status: "delivered", awaitingReply: true },
      { agentId: coderId, status: "held", reason: HUDDLE_TYPING_REASON },
    ],
  },
  {
    postId: "00000000-0000-4000-8000-000000000602",
    huddleId,
    number: 2,
    from: { kind: "agent", agentId: helperId },
    to: "person",
    kind: "note",
    text: "Here is the plan.",
    auto: true,
    cut: true,
    createdAt: "2026-01-01T10:02:00.000Z",
    deliveries: [],
  },
  {
    postId: "00000000-0000-4000-8000-000000000603",
    huddleId,
    number: 3,
    from: { kind: "agent", agentId: coderId },
    to: [helperId],
    kind: "assign",
    text: "Write the changelog.",
    decision: true,
    createdAt: "2026-01-01T10:03:00.000Z",
    deliveries: [{ agentId: helperId, status: "queued", reason: "Waiting for the current turn to end." }],
  },
] as unknown as HuddlePost[];

export function huddleProjection(overrides: Partial<RuntimeProjection> = {}): RuntimeProjection {
  return {
    environment: {
      environmentId: "00000000-0000-4000-8000-000000000001",
      label: "Local",
      protocolVersion: 1,
      capabilities: {},
    },
    projects: [{ projectId, path: "/work/web", name: "web" }],
    worktrees: [{ worktreeId, projectId, path: "/work/web", branch: "main", status: "ready", kind: "checkout" }],
    threads: [helper],
    terminals: [coder],
    browserTabs: [],
    attention: [],
    lastSequence: 1,
    huddles: [huddle()],
    huddlePosts: posts,
    ...overrides,
  } as unknown as RuntimeProjection;
}

/** Types into a React-controlled input. */
export async function typeInput(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

export async function click(element: Element | null | undefined): Promise<void> {
  if (!(element instanceof HTMLElement)) throw new Error("Nothing to click");
  await act(async () => element.click());
}

export function byLabel<T extends HTMLElement = HTMLButtonElement>(label: string, scope: ParentNode = document): T {
  const found = scope.querySelector<T>(`[aria-label="${label}"]`);
  if (!found) throw new Error(`Nothing labelled ${label}`);
  return found;
}

export function buttonNamed(text: string, scope: ParentNode = document): HTMLButtonElement {
  const found = [...scope.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === text || button.getAttribute("aria-label") === text,
  );
  if (!found) throw new Error(`No button ${text}`);
  return found;
}
