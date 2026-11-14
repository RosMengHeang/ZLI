// @vitest-environment jsdom

import {
  CommandId,
  EnvironmentId,
  ProjectId,
  type RuntimeProjection,
  type WorktreeProjection,
} from "@zli-v2/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ZliBridge } from "../runtime/bridge.js";
import { RuntimeProvider } from "../runtime/RuntimeProvider.js";
import type { ChatPlace } from "../sessions/launch.js";
import type { PendingLaunch } from "../sessions/sessions.js";
import { DraftChat } from "./DraftChat.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const alpha = ProjectId.parse("00000000-0000-4000-8000-0000000000a1");
const beta = ProjectId.parse("00000000-0000-4000-8000-0000000000b1");
const alphaCheckout = "00000000-0000-4000-8000-0000000000a2";
const betaCheckout = "00000000-0000-4000-8000-0000000000b2";

const projection = {
  environment: {
    environmentId: EnvironmentId.parse("00000000-0000-4000-8000-000000000001"),
    label: "Local",
    protocolVersion: 1,
    capabilities: {},
  },
  projects: [
    { projectId: alpha, path: "C:/code/alpha", name: "alpha" },
    { projectId: beta, path: "C:/code/beta", name: "beta" },
  ],
  worktrees: [
    {
      worktreeId: alphaCheckout,
      projectId: alpha,
      path: "C:/code/alpha",
      branch: "main",
      status: "ready",
      kind: "checkout",
    },
    {
      worktreeId: betaCheckout,
      projectId: beta,
      path: "C:/code/beta",
      branch: "main",
      status: "ready",
      kind: "checkout",
    },
  ],
  threads: [],
  terminals: [],
  browserTabs: [],
  attention: [],
  lastSequence: 1,
  providers: [
    {
      provider: "claude-code",
      displayName: "Claude Code",
      status: "found",
      path: "claude",
      models: [
        { id: "opus", label: "Opus" },
        { id: "sonnet", label: "Sonnet" },
      ],
    },
  ],
} as unknown as RuntimeProjection;

const worktree = (worktreeId: string) =>
  projection.worktrees.find((entry) => entry.worktreeId === worktreeId) as WorktreeProjection;

function bridge(): ZliBridge {
  return {
    runtime: {
      dispatch: async (request: { commandId: string; command: { type: string } }) => ({
        commandId: CommandId.parse(request.commandId),
        accepted: true as const,
        result: request.command.type === "history.scan" ? { folders: [] } : {},
      }),
      getProjection: async () => projection,
      onProjection: () => () => undefined,
    },
    app: { getVersion: async () => "0", quit: async () => undefined },
  } as unknown as ZliBridge;
}

afterEach(() => document.body.replaceChildren());

/**
 * A draft chat whose project menu moves it the way the app does: the same draft (same session) points at
 * another folder, and nothing else about it changes.
 */
async function renderDraft() {
  const container = document.createElement("div");
  document.body.append(container);
  const root: Root = createRoot(container);
  const runtimeBridge = bridge();
  let launch: PendingLaunch = {
    sessionId: "00000000-0000-4000-8000-0000000000d1",
    worktreeId: alphaCheckout,
    provider: "claude-code",
    mode: "chat",
    permissionMode: "supervised",
    model: "sonnet",
    draft: true,
    createdAt: "2026-11-12T00:00:00.000Z",
  };
  const moves: ChatPlace[] = [];
  const draw = () =>
    root.render(
      <RuntimeProvider bridge={runtimeBridge}>
        <DraftChat
          projection={projection}
          launch={launch}
          worktree={worktree(launch.worktreeId)}
          active
          onChange={() => undefined}
          onMove={async (place) => {
            moves.push(place);
            if (place.kind === "project") {
              launch = { ...launch, worktreeId: place.projectId === beta ? betaCheckout : alphaCheckout };
              draw();
            }
            return undefined;
          }}
          onAddFolder={async () => undefined}
          onSend={async () => undefined}
        />
      </RuntimeProvider>,
    );
  await act(async () => draw());
  return { container, moves, launch: () => launch };
}

const projectTab = (container: HTMLElement) =>
  container.querySelector<HTMLButtonElement>('button[aria-label^="Move this chat to another project"]');

async function pickProject(container: HTMLElement, name: string) {
  await act(async () => projectTab(container)?.click());
  const option = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
    (candidate) => candidate.querySelector(".picker-option-label")?.textContent === name,
  );
  await act(async () => option?.click());
}

async function type(textarea: HTMLTextAreaElement, text: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  await act(async () => {
    setValue?.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("DraftChat", () => {
  it("moves an empty draft to another project", async () => {
    const { container, moves, launch } = await renderDraft();
    expect(projectTab(container)?.textContent).toContain("alpha");
    await pickProject(container, "beta");
    expect(moves).toEqual([{ kind: "project", projectId: beta }]);
    expect(projectTab(container)?.textContent).toContain("beta");
    expect(launch()).toMatchObject({ provider: "claude-code", model: "sonnet", draft: true });
  });

  it("keeps what was typed when the draft moves", async () => {
    const { container } = await renderDraft();
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    await type(textarea, "fix the readme typo");
    await pickProject(container, "beta");
    expect(projectTab(container)?.textContent).toContain("beta");
    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("fix the readme typo");
    // And moving back keeps it too.
    await pickProject(container, "alpha");
    expect(projectTab(container)?.textContent).toContain("alpha");
    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("fix the readme typo");
  });

  it("lists every project and a way to add a folder, even with text typed", async () => {
    const { container } = await renderDraft();
    await type(container.querySelector("textarea") as HTMLTextAreaElement, "draft text");
    await act(async () => projectTab(container)?.click());
    await vi.waitFor(() => expect(document.querySelector(".place-menu-empty")).toBeNull());
    const labels = [...document.querySelectorAll('[role="option"] .picker-option-label')].map(
      (label) => label.textContent,
    );
    expect(labels).toEqual(["alpha", "beta", "Open a folder…"]);
  });
});
