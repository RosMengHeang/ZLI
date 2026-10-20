// @vitest-environment jsdom

import {
  CommandId,
  EnvironmentId,
  ProjectId,
  type RuntimeProjection,
  TerminalId,
  type TerminalProjection,
  WorktreeId,
} from "@zli-v2/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FileIndexProvider, type OpenFileRequest } from "../files/FileIndex.js";
import type { ZliBridge } from "../runtime/bridge.js";
import { RuntimeProvider } from "../runtime/RuntimeProvider.js";
import { drawerTerminals, TerminalDrawer } from "./TerminalDrawer.js";

type FakeLink = {
  text: string;
  range: { start: { x: number; y: number }; end: { x: number; y: number } };
  activate(event: { ctrlKey: boolean; metaKey: boolean }, text: string): void;
};

const xterm = vi.hoisted(() => {
  class FakeTerminal {
    static instances: FakeTerminal[] = [];
    cols = 80;
    rows = 24;
    readonly written: Array<string | Uint8Array> = [];
    resets = 0;
    disposed = false;
    private dataListener: ((data: string) => void) | undefined;
    readonly lines: string[] = [];
    readonly linkProviders: Array<{
      provideLinks(line: number, callback: (links: FakeLink[] | undefined) => void): void;
    }> = [];
    readonly buffer = {
      active: { getLine: (index: number) => ({ translateToString: () => this.lines[index] ?? "" }) },
    };
    constructor() {
      FakeTerminal.instances.push(this);
    }
    loadAddon(): void {}
    open(): void {}
    focus(): void {}
    write(data: string | Uint8Array): void {
      this.written.push(data);
    }
    reset(): void {
      this.resets += 1;
      this.written.length = 0;
    }
    onData(listener: (data: string) => void) {
      this.dataListener = listener;
      return { dispose: () => (this.dataListener = undefined) };
    }
    registerLinkProvider(provider: FakeTerminal["linkProviders"][number]) {
      this.linkProviders.push(provider);
      return { dispose: () => undefined };
    }
    type(data: string): void {
      this.dataListener?.(data);
    }
    text(): string {
      const decoder = new TextDecoder();
      return this.written
        .map((entry) => (typeof entry === "string" ? entry : decoder.decode(entry, { stream: true })))
        .join("");
    }
    dispose(): void {
      this.disposed = true;
    }
  }
  return { FakeTerminal };
});

vi.mock("@xterm/xterm", () => ({ Terminal: xterm.FakeTerminal }));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit(): void {}
  },
}));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const worktreeId = WorktreeId.parse("00000000-0000-4000-8000-000000000011");
const firstId = TerminalId.parse("00000000-0000-4000-8000-000000000021");
const secondId = TerminalId.parse("00000000-0000-4000-8000-000000000022");

function projectionWith(terminals: TerminalProjection[]): RuntimeProjection {
  return {
    environment: {
      environmentId: EnvironmentId.parse("00000000-0000-4000-8000-000000000001"),
      label: "Local",
      protocolVersion: 1,
      capabilities: { terminals: true },
    },
    projects: [{ projectId: ProjectId.parse("00000000-0000-4000-8000-000000000010"), path: "C:/repo", name: "repo" }],
    worktrees: [
      {
        worktreeId,
        projectId: ProjectId.parse("00000000-0000-4000-8000-000000000010"),
        path: "C:/repo",
        branch: "main",
        status: "ready",
      },
    ],
    threads: [],
    terminals,
    browserTabs: [],
    attention: [],
    lastSequence: 1,
  };
}

type TerminalListener = Parameters<ZliBridge["runtime"]["onTerminal"]>[0];

function makeBridge() {
  const listeners = new Set<TerminalListener>();
  const dispatched: Array<{ command: Record<string, unknown> }> = [];
  const attaches: Array<[string, number | undefined]> = [];
  const bridge = {
    runtime: {
      dispatch: vi.fn(async (request: { command: Record<string, unknown> }) => {
        dispatched.push(request);
        return {
          commandId: CommandId.parse("00000000-0000-4000-8000-000000000099"),
          accepted: true as const,
          ...(request.command.type === "files.list"
            ? { result: { files: [{ path: "src/app.ts" }, { path: "README.md" }], truncated: false } }
            : {}),
        };
      }),
      getProjection: async () => projectionWith([]),
      onProjection: () => () => undefined,
      attachTerminal: vi.fn(async (terminalId: string, afterSequence?: number) => {
        attaches.push([terminalId, afterSequence]);
        return { accepted: true };
      }),
      onTerminal: (listener: TerminalListener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  } as unknown as ZliBridge;
  const emit = (message: Parameters<TerminalListener>[0]) => {
    for (const listener of listeners) listener(message);
  };
  return { bridge, dispatched, attaches, emit };
}

const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

async function render(
  bridge: ZliBridge,
  terminals: TerminalProjection[],
  sessionId?: string,
  onOpenFile?: (request: OpenFileRequest) => void,
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const projection = projectionWith(terminals);
  const drawer = (
    <TerminalDrawer
      projection={projection}
      worktree={projection.worktrees[0]}
      sessionId={sessionId}
      height={280}
      onHeightChange={() => undefined}
      onClose={() => undefined}
    />
  );
  await act(async () => {
    root.render(
      <RuntimeProvider bridge={bridge}>
        {onOpenFile ? <FileIndexProvider onOpenFile={onOpenFile}>{drawer}</FileIndexProvider> : drawer}
      </RuntimeProvider>,
    );
  });
  return container;
}

const button = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === name || candidate.getAttribute("aria-label") === name,
  );

beforeEach(() => {
  xterm.FakeTerminal.instances.length = 0;
});
afterEach(() => document.body.replaceChildren());

describe("TerminalDrawer", () => {
  it("opens file paths in the output with Ctrl+click", async () => {
    const { bridge } = makeBridge();
    const opened: OpenFileRequest[] = [];
    await render(
      bridge,
      [{ terminalId: firstId, worktreeId, title: "Terminal 1", status: "running", lastSequence: 0 }],
      undefined,
      (request) => opened.push(request),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const terminal = xterm.FakeTerminal.instances[0];
    if (!terminal) throw new Error("No terminal");
    terminal.lines[0] = "error at C:\\repo\\src\\app.ts:12:5 and see README.md";
    let links: FakeLink[] | undefined;
    terminal.linkProviders[0]?.provideLinks(1, (found) => {
      links = found;
    });
    expect(links?.map((link) => link.text)).toEqual(["C:\\repo\\src\\app.ts:12:5", "README.md"]);
    expect(links?.[0]?.range).toEqual({ start: { x: 10, y: 1 }, end: { x: 32, y: 1 } });

    links?.[0]?.activate({ ctrlKey: false, metaKey: false }, "");
    expect(opened).toEqual([]);
    links?.[0]?.activate({ ctrlKey: true, metaKey: false }, "");
    expect(opened).toEqual([{ worktreeId, path: "src/app.ts", line: 12, column: 5 }]);
  });

  it("replays buffered bytes, decoding characters split across chunks", async () => {
    const { bridge, attaches, emit } = makeBridge();
    await render(bridge, [
      { terminalId: firstId, worktreeId, title: "Terminal 1", status: "running", lastSequence: 3 },
    ]);
    expect(attaches[0]).toEqual([firstId, 0]);
    const euro = new TextEncoder().encode("€");
    await act(async () => {
      emit({
        kind: "snapshot",
        snapshot: {
          terminalId: firstId,
          chunks: [
            { terminalId: firstId, sequence: 1, bytesBase64: base64(new TextEncoder().encode("price ")) },
            { terminalId: firstId, sequence: 2, bytesBase64: base64(euro.subarray(0, 2)) },
          ],
          nextSequence: 2,
          truncated: false,
        },
      });
      emit({
        kind: "stream",
        message: { kind: "chunk", chunk: { terminalId: firstId, sequence: 3, bytesBase64: base64(euro.subarray(2)) } },
      });
      emit({
        kind: "stream",
        message: { kind: "chunk", chunk: { terminalId: firstId, sequence: 3, bytesBase64: base64(euro.subarray(2)) } },
      });
    });
    expect(xterm.FakeTerminal.instances[0]?.text()).toBe("price €");
  });

  it("sends raw keystrokes, including control characters, as terminal writes", async () => {
    const { bridge, dispatched } = makeBridge();
    await render(bridge, [
      { terminalId: firstId, worktreeId, title: "Terminal 1", status: "running", lastSequence: 0 },
    ]);
    await act(async () => {
      xterm.FakeTerminal.instances[0]?.type("\x03");
      xterm.FakeTerminal.instances[0]?.type("\x1b[A");
    });
    const writes = dispatched.filter((request) => request.command.type === "terminal.write");
    expect(writes.map((request) => request.command.data)).toEqual(["\x03", "\x1b[A"]);
    expect(dispatched.some((request) => request.command.type === "terminal.resize")).toBe(true);
  });

  it("redraws the full history when a restarted runtime resets terminal sequences", async () => {
    const { bridge, attaches, emit } = makeBridge();
    await render(bridge, [
      { terminalId: firstId, worktreeId, title: "Terminal 1", status: "running", lastSequence: 5 },
    ]);
    await act(async () => {
      emit({
        kind: "snapshot",
        snapshot: {
          terminalId: firstId,
          chunks: [{ terminalId: firstId, sequence: 1, bytesBase64: base64(new TextEncoder().encode("old")) }],
          nextSequence: 5,
          truncated: false,
        },
      });
      emit({ kind: "snapshot", snapshot: { terminalId: firstId, chunks: [], nextSequence: 2, truncated: false } });
    });
    expect(xterm.FakeTerminal.instances[0]?.resets).toBe(1);
    expect(attaches.at(-1)).toEqual([firstId, 0]);
  });

  it("ignores a snapshot answering another attach and asks again from its own position", async () => {
    const { bridge, attaches, emit } = makeBridge();
    await render(bridge, [
      { terminalId: firstId, worktreeId, title: "Terminal 1", status: "running", lastSequence: 9 },
    ]);
    await act(async () => {
      emit({
        kind: "snapshot",
        snapshot: {
          terminalId: firstId,
          chunks: [{ terminalId: firstId, sequence: 9, bytesBase64: base64(new TextEncoder().encode("tail")) }],
          nextSequence: 9,
          truncated: false,
        },
      });
      emit({
        kind: "stream",
        message: {
          kind: "chunk",
          chunk: { terminalId: firstId, sequence: 10, bytesBase64: base64(new TextEncoder().encode("x")) },
        },
      });
    });
    expect(xterm.FakeTerminal.instances[0]?.text()).toBe("");
    await vi.waitFor(() => expect(attaches.length).toBeGreaterThan(1));
    expect(attaches.every(([, afterSequence]) => afterSequence === 0)).toBe(true);
  });

  it("shows shell terminals side by side and leaves agent CLIs to their tiles", async () => {
    const { bridge, attaches } = makeBridge();
    const container = await render(bridge, [
      { terminalId: firstId, worktreeId, title: "Terminal 1", status: "exited", lastSequence: 0 },
      { terminalId: secondId, worktreeId, title: "Terminal 2", status: "running", lastSequence: 0 },
      {
        terminalId: TerminalId.parse("00000000-0000-4000-8000-000000000023"),
        worktreeId,
        title: "Claude Code",
        status: "running",
        lastSequence: 0,
        kind: "agent",
        agent: { provider: "claude-code" },
      },
    ]);
    const titles = [...container.querySelectorAll(".drawer-pane-title")].map((title) => title.textContent);
    expect(titles).toEqual(["Terminal 1", "Terminal 2"]);
    expect(new Set(attaches.map(([terminalId]) => terminalId))).toEqual(new Set([firstId, secondId]));
    expect(container.textContent).toContain("Exited");
  });

  it("keeps each session's shells apart and tags new splits with the session", async () => {
    const sessionId = "00000000-0000-4000-8000-000000000201";
    const otherSession = "00000000-0000-4000-8000-000000000202";
    const { bridge, dispatched } = makeBridge();
    const container = await render(
      bridge,
      [
        { terminalId: firstId, worktreeId, title: "Mine", status: "running", lastSequence: 0, sessionId },
        {
          terminalId: secondId,
          worktreeId,
          title: "Theirs",
          status: "running",
          lastSequence: 0,
          sessionId: otherSession,
        },
      ] as TerminalProjection[],
      sessionId,
    );
    const titles = [...container.querySelectorAll(".drawer-pane-title")].map((title) => title.textContent);
    expect(titles).toEqual(["Mine"]);
    await act(async () => button(container, "Split")?.click());
    expect(dispatched.at(-1)?.command).toMatchObject({
      type: "terminal.create",
      worktreeId,
      sessionId,
      title: "Terminal 2",
    });
  });

  it("stops a running shell when its pane closes", async () => {
    const { bridge, dispatched } = makeBridge();
    const container = await render(bridge, [
      { terminalId: firstId, worktreeId, title: "Terminal 1", status: "running", lastSequence: 0 },
    ]);
    await act(async () => button(container, "Stop Terminal 1")?.click());
    expect(dispatched.at(-1)?.command).toEqual({ type: "terminal.stop", terminalId: firstId });
    expect(container.querySelectorAll(".drawer-pane")).toHaveLength(0);
  });

  it("offers to start a shell when the worktree has none", async () => {
    const { bridge, dispatched } = makeBridge();
    const container = await render(bridge, []);
    expect(container.querySelector(".terminal-drawer")?.classList.contains("is-compact")).toBe(true);
    expect(container.querySelector('[role="separator"]')).toBeNull();
    await act(async () => button(container, "Start terminal")?.click());
    expect(dispatched.at(-1)?.command).toMatchObject({ type: "terminal.create", worktreeId, cwd: "C:/repo" });
  });

  it("filters terminals by worktree and session", () => {
    const shared = { worktreeId, title: "t", status: "running" as const };
    const terminals = [
      { ...shared, terminalId: firstId },
      { ...shared, terminalId: secondId, kind: "agent" as const },
    ] as TerminalProjection[];
    expect(drawerTerminals(terminals, worktreeId, undefined).map((terminal) => terminal.terminalId)).toEqual([firstId]);
    expect(drawerTerminals(terminals, undefined, undefined)).toEqual([]);
  });
});
