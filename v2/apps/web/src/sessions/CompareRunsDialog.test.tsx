import { CommandId, EnvironmentId, type RuntimeProjection } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ZliBridge } from "../runtime/bridge.js";
import { RuntimeProvider } from "../runtime/RuntimeProvider.js";
import type { RunGroup } from "./bestOf.js";
import { CompareRunsDialog } from "./CompareRunsDialog.js";
import type { AgentSession } from "./sessions.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const projectId = "00000000-0000-4000-8000-000000000010";
const worktreeIds = ["00000000-0000-4000-8000-000000000101", "00000000-0000-4000-8000-000000000102"];
const threadIds = ["00000000-0000-4000-8000-000000000201", "00000000-0000-4000-8000-000000000202"];
const checkpointIds = [
  "00000000-0000-4000-8000-000000000301",
  "00000000-0000-4000-8000-000000000302",
  "00000000-0000-4000-8000-000000000303",
];

const sessions: AgentSession[] = [0, 1].map((index) => ({
  sessionId: `s${index + 1}`,
  worktreeId: worktreeIds[index] ?? "",
  provider: index === 0 ? "codex" : "claude",
  status: "ready",
  mode: "chat",
  thread: {
    threadId: threadIds[index],
    worktreeId: worktreeIds[index],
    provider: index === 0 ? "codex" : "claude",
    status: "idle",
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: `2026-11-01T10:0${index + 2}:30.000Z`,
    ...(index === 1 ? { model: "sonnet" } : {}),
  },
})) as unknown as AgentSession[];

const group: RunGroup = {
  groupId: "g",
  sourceSessionId: "source",
  label: "main",
  prompt: "Add a login page\nwith tests",
  sessionIds: ["s1", "s2"],
  createdAt: "2026-11-01T10:00:00.000Z",
};

function checkpoint(checkpointId: string, threadId: string, worktreeId: string, files: [string, number, number][]) {
  return {
    checkpointId,
    threadId,
    worktreeId,
    turnId: checkpointId,
    startTree: "a".repeat(40),
    endTree: "b".repeat(40),
    files: files.map(([path, additions, deletions]) => ({
      path,
      kind: "modified",
      additions,
      deletions,
      binary: false,
    })),
    fileCount: files.length,
    additions: files.reduce((sum, [, additions]) => sum + additions, 0),
    deletions: files.reduce((sum, [, , deletions]) => sum + deletions, 0),
  };
}

function baseProjection(): RuntimeProjection {
  return {
    environment: {
      environmentId: EnvironmentId.parse("00000000-0000-4000-8000-000000000001"),
      label: "Local",
      protocolVersion: 1,
      capabilities: {},
    },
    projects: [{ projectId, path: "/repo", name: "repo" }],
    worktrees: worktreeIds.map((worktreeId, index) => ({
      worktreeId,
      projectId,
      path: `/repo-run${index + 1}`,
      branch: `main-run${index + 1}`,
      status: "ready",
      kind: "worktree",
    })),
    threads: sessions.map((session) => session.thread),
    terminals: [],
    browserTabs: [],
    attention: [],
    messages: [
      { messageId: "m1", threadId: threadIds[0], role: "user", text: "Add a login page" },
      { messageId: "m2", threadId: threadIds[0], role: "assistant", text: "Added the page and two tests." },
      { messageId: "m3", threadId: threadIds[1], role: "user", text: "Add a login page" },
      { messageId: "m4", threadId: threadIds[1], role: "assistant", text: "Built the form." },
    ],
    usage: [{ threadId: threadIds[0], usage: { inputTokens: 12_000, outputTokens: 3_000, costUsd: 0.42 } }],
    activities: [
      { activityId: "a1", threadId: threadIds[0], kind: "command", title: "pnpm test", status: "completed" },
    ],
    checkpoints: [
      checkpoint(checkpointIds[0] ?? "", threadIds[0] ?? "", worktreeIds[0] ?? "", [
        ["src/login.tsx", 40, 0],
        ["src/app.tsx", 2, 1],
      ]),
      checkpoint(checkpointIds[1] ?? "", threadIds[1] ?? "", worktreeIds[1] ?? "", [["src/login.tsx", 30, 0]]),
      checkpoint(checkpointIds[2] ?? "", threadIds[1] ?? "", worktreeIds[1] ?? "", [
        ["src/login.tsx", 5, 2],
        ["src/form.css", 12, 0],
      ]),
    ],
    lastSequence: 1,
  } as unknown as RuntimeProjection;
}

type Respond = (command: Record<string, unknown>) => { result: unknown } | { error: string };

const roots: Root[] = [];

async function render(respond: Respond, props: Partial<Parameters<typeof CompareRunsDialog>[0]> = {}) {
  const commands: Record<string, unknown>[] = [];
  let projection = baseProjection();
  let listener: ((next: RuntimeProjection) => void) | undefined;
  const bridge = {
    runtime: {
      dispatch: async (request: { command: Record<string, unknown> }) => {
        commands.push(request.command);
        const reply = respond(request.command);
        const commandId = CommandId.parse("00000000-0000-4000-8000-000000000099");
        return "error" in reply
          ? { commandId, accepted: false, error: { code: "invalid_request", message: reply.error, retryable: false } }
          : { commandId, accepted: true, result: reply.result };
      },
      getProjection: async () => projection,
      onProjection: (next: (value: RuntimeProjection) => void) => {
        listener = next;
        return () => undefined;
      },
    },
  } as unknown as ZliBridge;
  const handlers = {
    onViewDiff: vi.fn(),
    onKeep: vi.fn(),
    onKeepParts: vi.fn(),
    onOpenPreview: vi.fn(),
    onClose: vi.fn(),
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <RuntimeProvider bridge={bridge}>
        <CompareRunsDialog group={group} sessions={sessions} {...handlers} {...props} />
      </RuntimeProvider>,
    );
  });
  const update = async (change: (current: RuntimeProjection) => RuntimeProjection) => {
    projection = { ...change(projection), lastSequence: projection.lastSequence + 1 };
    await act(async () => listener?.(projection));
  };
  return { commands, handlers, update };
}

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  localStorage.clear();
});

const button = (text: string, scope: ParentNode = document) =>
  [...scope.querySelectorAll("button")].find((item) => item.textContent === text);
const byLabel = (label: string) => document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
const click = async (element: Element | null | undefined) => {
  if (!element) throw new Error("Nothing to click.");
  await act(async () => (element as HTMLElement).click());
};
const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

describe("CompareRunsDialog", () => {
  it("shows each run's numbers, reply and files side by side", async () => {
    await render(() => ({ result: {} }));
    const first = byLabel("Run 1");
    const second = byLabel("Run 2");
    expect(first?.textContent).toContain("Done");
    expect(first?.textContent).toContain("2m 30s");
    expect(first?.textContent).toContain("$0.42");
    expect(first?.textContent).toContain("15k");
    expect(first?.textContent).toContain("2 files");
    expect(first?.textContent).toContain("1 passed");
    expect(first?.textContent).toContain("Added the page and two tests.");
    expect(second?.textContent).toContain("sonnet");
    expect(second?.textContent).toContain("Not reported");
    // No check commands ran in run 2, so the row is left out instead of guessed.
    expect(second?.textContent).not.toContain("Checks");
    expect(second?.textContent).toContain("Built the form.");
  });

  it("puts every changed file in one table with what each run did to it", async () => {
    await render(() => ({ result: {} }));
    const rows = [...document.querySelectorAll(".runs-compare-matrix tbody tr")];
    expect(rows.map((row) => row.querySelector("th")?.textContent)).toEqual([
      "src/app.tsx",
      "src/form.css",
      "src/login.tsx",
    ]);
    expect(byLabel("Run 1, src/login.tsx: 40 added, 0 removed")?.tagName).toBe("BUTTON");
    // Run 2 changed login.tsx in two turns; the cell adds them up.
    expect(byLabel("Run 2, src/login.tsx: 35 added, 2 removed")?.tagName).toBe("BUTTON");
    expect(document.querySelector('[title="Run 2, src/app.tsx: not changed"]')?.tagName).toBe("SPAN");
    expect(rows[2]?.className).toContain("is-shared");
  });

  it("opens a run's diff of a file across all of its turns from a cell", async () => {
    const { commands } = await render((command) =>
      command.type === "checkpoint.diff"
        ? {
            result: {
              path: "src/login.tsx",
              binary: false,
              truncated: false,
              patch: "diff --git a/src/login.tsx b/src/login.tsx\n@@ -1 +1 @@\n-old\n+new\n",
            },
          }
        : { result: {} },
    );
    await click(byLabel("Run 2, src/login.tsx: 35 added, 2 removed"));
    await flush();
    expect(commands.find((command) => command.type === "checkpoint.diff")).toEqual({
      type: "checkpoint.diff",
      checkpointId: checkpointIds[1],
      path: "src/login.tsx",
      throughCheckpointId: checkpointIds[2],
    });
    const diff = byLabel("Run 2 diff");
    expect(diff?.textContent).toContain("new");
    await click(byLabel("Close diff"));
    expect(byLabel("Run 2 diff")).toBeNull();
  });

  it("keeps one run with files picked from another", async () => {
    const { handlers } = await render(() => ({ result: {} }));
    await click(button("Keep parts", byLabel("Run 1") ?? document));
    expect(document.body.textContent).toContain("Keeping run 1.");
    // Run 1 never touched form.css, so its choice reads "as is"; run 2's version can be picked instead.
    const formRow = [...document.querySelectorAll(".runs-compare-matrix tbody tr")].find(
      (row) => row.querySelector("th")?.textContent === "src/form.css",
    );
    expect(formRow?.textContent).toContain("as is");
    await click(byLabel("Use Run 2, src/form.css: 12 added, 0 removed"));
    await click(byLabel("Use Run 2, src/login.tsx: 35 added, 2 removed"));
    expect(document.body.textContent).toContain("2 files from other runs go into run 1.");
    await click(byLabel("Keep run 1's src/login.tsx"));
    expect(document.body.textContent).toContain("1 file from other runs go into run 1.");
    await click(button("Keep run 1"));
    expect(handlers.onKeepParts).toHaveBeenCalledWith(sessions[0], [{ from: sessions[1], paths: ["src/form.css"] }]);
  });

  it("starts a run's app with the detected command and opens it once it prints an address", async () => {
    const { commands, handlers, update } = await render((command) => {
      if (command.type === "files.read" && command.path === "package.json") {
        return {
          result: {
            path: "package.json",
            size: 10,
            version: "v",
            content: JSON.stringify({ scripts: { dev: "vite" } }),
            binary: false,
            tooLarge: false,
            bom: false,
            lineEnding: "lf",
          },
        };
      }
      if (command.type === "files.read") return { error: "missing" };
      return { result: {} };
    });
    await click(button("Preview", byLabel("Run 2") ?? document));
    await flush();
    const started = commands.find((command) => command.type === "terminal.create");
    expect(started).toMatchObject({
      worktreeId: worktreeIds[1],
      cwd: "/repo-run2",
      title: "Preview, run 2",
    });
    expect(JSON.stringify(started?.args)).toContain("npm install && npm run dev");
    expect(button("Starting", byLabel("Run 2") ?? document)).toBeDefined();
    expect(document.body.textContent).toContain("npm install && npm run dev");

    await update(
      (current) =>
        ({
          ...current,
          devServers: [
            {
              worktreeId: worktreeIds[1],
              terminalId: started?.terminalId,
              url: "http://localhost:5174/",
              port: 5174,
              detectedAt: "2026-11-01T10:05:00.000Z",
            },
          ],
        }) as unknown as RuntimeProjection,
    );
    await click(button("Open preview", byLabel("Run 2") ?? document));
    expect(handlers.onOpenPreview).toHaveBeenCalledWith(sessions[1], "http://localhost:5174/");
    // Run 1 has its own worktree and no server yet.
    expect(button("Preview", byLabel("Run 1") ?? document)).toBeDefined();
  });

  it("asks once for the command when the project names none, then remembers it", async () => {
    const { commands } = await render((command) =>
      command.type === "files.read" ? { error: "missing" } : { result: {} },
    );
    await click(button("Preview", byLabel("Run 1") ?? document));
    await flush();
    const input = document.querySelector<HTMLInputElement>('[aria-label="Preview command"] input');
    expect(input).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "make serve");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(button("Start preview"));
    await flush();
    expect(commands.filter((command) => command.type === "terminal.create")).toHaveLength(1);
    expect(localStorage.getItem(`zli.previewCommand.${projectId}`)).toBe("make serve");

    await click(button("Preview", byLabel("Run 2") ?? document));
    await flush();
    expect(document.querySelector('[aria-label="Preview command"]')).toBeNull();
    expect(commands.filter((command) => command.type === "terminal.create")).toHaveLength(2);
  });
});
