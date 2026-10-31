import { CommandId, EnvironmentId, ProjectId, type RuntimeProjection, WorktreeId } from "@zli-v2/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { ZliBridge } from "../runtime/bridge.js";
import { RuntimeProvider } from "../runtime/RuntimeProvider.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

export const worktree = {
  worktreeId: WorktreeId.parse("00000000-0000-4000-8000-000000000101"),
  projectId: ProjectId.parse("00000000-0000-4000-8000-000000000010"),
  path: "C:/app",
  branch: "feature",
  status: "ready" as const,
  kind: "checkout" as const,
};

export type Reply = { result: unknown } | { error: string };
export type Responder = (command: Record<string, unknown>) => Reply;

const roots: Root[] = [];

/** Renders `node` inside a runtime whose dispatch answers with `respond` and records every command. */
export async function renderWithRuntime(node: ReactNode, respond: Responder): Promise<Record<string, unknown>[]> {
  const commands: Record<string, unknown>[] = [];
  const projection = {
    environment: {
      environmentId: EnvironmentId.parse("00000000-0000-4000-8000-000000000001"),
      label: "Local",
      protocolVersion: 1,
      capabilities: {},
    },
    projects: [],
    worktrees: [worktree],
    threads: [],
    terminals: [],
    browserTabs: [],
    attention: [],
    lastSequence: 1,
  } as unknown as RuntimeProjection;
  const commandId = CommandId.parse("00000000-0000-4000-8000-000000000099");
  const bridge = {
    runtime: {
      dispatch: async (request: { command: Record<string, unknown> }) => {
        commands.push(request.command);
        const reply = respond(request.command);
        return "error" in reply
          ? {
              commandId,
              accepted: false,
              error: { code: "invalid_request", message: reply.error, retryable: false },
            }
          : { commandId, accepted: true, result: reply.result };
      },
      getProjection: async () => projection,
      onProjection: () => () => undefined,
    },
  } as unknown as ZliBridge;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<RuntimeProvider bridge={bridge}>{node}</RuntimeProvider>);
  });
  return commands;
}

export async function cleanupRuntimeRenders(): Promise<void> {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
}

export const buttonByText = (text: string, scope: ParentNode = document) =>
  [...scope.querySelectorAll("button")].find((item) => item.textContent === text);

export const buttonByLabel = (label: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`) ?? undefined;

/** Types into a React-controlled textarea. */
export async function typeInto(textarea: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

export async function pressModEnter(target: HTMLElement): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
  });
}
