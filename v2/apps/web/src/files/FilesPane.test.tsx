// @vitest-environment jsdom

import { EditorView } from "@codemirror/view";
import {
  CommandId,
  EnvironmentId,
  type FileReadResult,
  ProjectId,
  type RpcResponse,
  type RuntimeProjection,
  WorktreeId,
} from "@zli-v2/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { ZliBridge } from "../runtime/bridge.js";
import { RuntimeProvider } from "../runtime/RuntimeProvider.js";
import { FileIndexProvider } from "./FileIndex.js";
import { type FilesFocus, FilesPane } from "./FilesPane.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

beforeAll(() => {
  // jsdom has no layout engine; CodeMirror measures ranges while drawing the cursor and selection.
  const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
  const rects = Object.assign([], { item: () => null }) as unknown as DOMRectList;
  Range.prototype.getClientRects = () => rects;
  Range.prototype.getBoundingClientRect = () => rect as DOMRect;
});

const worktree = {
  worktreeId: WorktreeId.parse("00000000-0000-4000-8000-000000000011"),
  projectId: ProjectId.parse("00000000-0000-4000-8000-000000000010"),
  path: "C:/repo",
  branch: "main",
  status: "ready" as const,
};

const projection: RuntimeProjection = {
  environment: {
    environmentId: EnvironmentId.parse("00000000-0000-4000-8000-000000000001"),
    label: "Local",
    protocolVersion: 1,
    capabilities: { worktrees: true, terminals: true, browser: true, eventReplay: true },
  },
  projects: [{ projectId: worktree.projectId, path: "C:/repo", name: "repo" }],
  worktrees: [worktree],
  threads: [],
  terminals: [],
  browserTabs: [],
  attention: [],
  lastSequence: 1,
};

type Disk = Map<string, { content: string; version: string; lineEnding?: "lf" | "crlf" }>;
type Command = { type: string; path?: string; content?: string; expectedVersion?: string; overwrite?: boolean };

function fakeRuntime(disk: Disk, options: { conflictOnce?: boolean } = {}) {
  const commands: Command[] = [];
  let conflictOnce = options.conflictOnce ?? false;
  let revision = 10;
  const reply = (result: unknown): RpcResponse => ({
    commandId: CommandId.parse("00000000-0000-4000-8000-000000000099"),
    accepted: true,
    result,
  });
  const dispatch = async (request: unknown): Promise<RpcResponse> => {
    const command = (request as { command: Command }).command;
    commands.push(command);
    if (command.type === "files.list") {
      return reply({
        files: [...disk.keys()].sort().map((path) => (path === "src/app.ts" ? { path, status: "modified" } : { path })),
        truncated: false,
      });
    }
    const path = command.path ?? "";
    const file = disk.get(path);
    if (command.type === "files.read") {
      if (!file) {
        return {
          commandId: CommandId.parse("00000000-0000-4000-8000-000000000099"),
          accepted: false,
          error: { code: "invalid_request", message: `File not found: ${path}`, retryable: false },
        };
      }
      const result: FileReadResult = {
        path,
        size: file.content.length,
        version: file.version,
        content: file.content,
        binary: false,
        tooLarge: false,
        bom: false,
        lineEnding: file.lineEnding ?? "lf",
      };
      return reply(result);
    }
    if (command.type === "files.write") {
      if (conflictOnce && !command.overwrite) {
        conflictOnce = false;
        return reply({ status: "conflict", path, version: "someone-else" });
      }
      revision += 1;
      const version = `v${revision}`;
      disk.set(path, { content: command.content ?? "", version });
      return reply({ status: "saved", path, version, size: (command.content ?? "").length });
    }
    throw new Error(`unexpected ${command.type}`);
  };
  const bridge = {
    runtime: {
      dispatch,
      getProjection: async () => projection,
      onProjection: () => () => undefined,
      attachTerminal: async () => ({ accepted: true }),
      onTerminal: () => () => undefined,
    },
  } as unknown as ZliBridge;
  return { bridge, commands };
}

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

const settle = (ms = 0) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

async function renderPane(bridge: ZliBridge, focus?: FilesFocus) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const render = async (nextFocus?: FilesFocus) => {
    await act(async () => {
      root?.render(
        <RuntimeProvider bridge={bridge}>
          <FileIndexProvider onOpenFile={() => undefined}>
            <FilesPane
              worktree={worktree}
              focus={nextFocus}
              onOpenDiff={() => undefined}
              onQuickOpen={() => undefined}
            />
          </FileIndexProvider>
        </RuntimeProvider>,
      );
    });
    await settle();
    await settle();
  };
  await render(focus);
  return { container, render };
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label || candidate.getAttribute("aria-label") === label,
  );
  if (!match) throw new Error(`No button ${label}`);
  return match;
}

function editorView(container: HTMLElement): EditorView {
  const element = container.querySelector<HTMLElement>(".cm-editor");
  const view = element ? EditorView.findFromDOM(element) : null;
  if (!view) throw new Error("No editor");
  return view;
}

describe("FilesPane", () => {
  it("shows the tree with change markers and opens a file in the editor", async () => {
    const disk: Disk = new Map([
      ["README.md", { content: "# Demo\n", version: "r1" }],
      ["src/app.ts", { content: "const a = 1;\n", version: "v1" }],
    ]);
    const { bridge } = fakeRuntime(disk);
    const { container } = await renderPane(bridge);

    const folder = button(container, "src");
    expect(folder.querySelector(".file-row-changed")).not.toBeNull();
    act(() => folder.click());
    const file = button(container, "app.tsM");
    expect(file.querySelector(".file-status-modified")?.textContent).toBe("M");
    act(() => file.click());
    await settle();
    await settle();

    expect(editorView(container).state.doc.toString()).toBe("const a = 1;\n");
    expect(container.querySelector(".file-path")?.textContent).toBe("src/app.ts");
    expect(button(container, "Saved").disabled).toBe(true);
  });

  it("saves edits with the version it read and marks the tab clean", async () => {
    const disk: Disk = new Map([["src/app.ts", { content: "const a = 1;\n", version: "v1" }]]);
    const { bridge, commands } = fakeRuntime(disk);
    const { container } = await renderPane(bridge, { kind: "open", path: "src/app.ts", line: 1, nonce: 1 });

    const view = editorView(container);
    act(() => view.dispatch({ changes: { from: 0, insert: "// note\n" } }));
    await settle(200);
    expect(container.querySelector(".file-tab-dirty")).not.toBeNull();

    act(() => button(container, "Save").click());
    await settle();
    await settle();

    const write = commands.find((command) => command.type === "files.write");
    expect(write).toMatchObject({ path: "src/app.ts", content: "// note\nconst a = 1;\n", expectedVersion: "v1" });
    expect(disk.get("src/app.ts")?.content).toBe("// note\nconst a = 1;\n");
    expect(container.querySelector(".file-tab-dirty")).toBeNull();
  });

  it("asks before overwriting a file that changed on disk", async () => {
    const disk: Disk = new Map([["src/app.ts", { content: "const a = 1;\n", version: "v1" }]]);
    const { bridge, commands } = fakeRuntime(disk, { conflictOnce: true });
    const { container } = await renderPane(bridge, { kind: "open", path: "src/app.ts", nonce: 1 });

    act(() => editorView(container).dispatch({ changes: { from: 0, insert: "x" } }));
    await settle(200);
    act(() => button(container, "Save").click());
    await settle();
    expect(container.querySelector(".file-banner")?.textContent).toContain("changed on disk after you opened it");
    expect(disk.get("src/app.ts")?.content).toBe("const a = 1;\n");

    act(() => button(container, "Overwrite with mine").click());
    await settle();
    await settle();
    expect(commands.filter((command) => command.type === "files.write").at(-1)).toMatchObject({ overwrite: true });
    expect(disk.get("src/app.ts")?.content).toBe("xconst a = 1;\n");
    expect(container.querySelector(".file-banner")).toBeNull();
  });

  it("follows edits made on disk while the file is clean, and warns while it has unsaved edits", async () => {
    const disk: Disk = new Map([["src/app.ts", { content: "one\n", version: "v1" }]]);
    const { bridge } = fakeRuntime(disk);
    const { container } = await renderPane(bridge, { kind: "open", path: "src/app.ts", nonce: 1 });

    disk.set("src/app.ts", { content: "one\ntwo\n", version: "v2" });
    act(() => button(container, "Reload file list").click());
    await settle();
    await settle();
    expect(editorView(container).state.doc.toString()).toBe("one\ntwo\n");

    act(() => editorView(container).dispatch({ changes: { from: 0, insert: "mine " } }));
    await settle(200);
    disk.set("src/app.ts", { content: "agent\n", version: "v3" });
    act(() => button(container, "Reload file list").click());
    await settle();
    await settle();
    expect(container.querySelector(".file-banner")?.textContent).toContain("changed on disk while you were editing");
    expect(editorView(container).state.doc.toString()).toBe("mine one\ntwo\n");

    act(() => button(container, "Reload from disk").click());
    await settle();
    await settle();
    expect(editorView(container).state.doc.toString()).toBe("agent\n");
    expect(container.querySelector(".file-tab-dirty")).toBeNull();
  });

  it("follows edits made on disk after the file was saved", async () => {
    const disk: Disk = new Map([["README.md", { content: "# Demo\n", version: "r1" }]]);
    const { bridge } = fakeRuntime(disk);
    const { container } = await renderPane(bridge, { kind: "open", path: "README.md", nonce: 1 });

    const view = editorView(container);
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "Edited\n" } }));
    await settle(200);
    act(() => button(container, "Save").click());
    await settle();
    await settle();
    expect(container.querySelector(".file-tab-dirty")).toBeNull();
    await settle(400);

    disk.set("README.md", { content: "# Changed by an agent\n", version: "r9" });
    act(() => button(container, "Reload file list").click());
    await settle();
    await settle();
    await settle(400);
    expect(editorView(container).state.doc.toString()).toBe("# Changed by an agent\n");
    expect(container.querySelector(".file-tab-dirty")).toBeNull();
  });

  it("follows a clean file whose line endings change on disk", async () => {
    const disk: Disk = new Map([["README.md", { content: "# Demo\r\nline\r\n", version: "r1", lineEnding: "crlf" }]]);
    const { bridge } = fakeRuntime(disk);
    const { container } = await renderPane(bridge, { kind: "open", path: "README.md", nonce: 1 });
    expect(editorView(container).state.doc.lines).toBe(3);

    disk.set("README.md", { content: "# Changed by an agent\n", version: "r2", lineEnding: "lf" });
    act(() => button(container, "Reload file list").click());
    await settle();
    await settle();
    await settle(400);
    expect(editorView(container).state.doc.toString()).toBe("# Changed by an agent\n");
    expect(container.querySelector(".file-tab-dirty")).toBeNull();
  });

  it("keeps unsaved edits when the panel closes and opens again", async () => {
    const disk: Disk = new Map([["src/app.ts", { content: "one\n", version: "v1" }]]);
    const { bridge } = fakeRuntime(disk);
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const tree = (showPane: boolean, focus?: FilesFocus) => (
      <RuntimeProvider bridge={bridge}>
        <FileIndexProvider onOpenFile={() => undefined}>
          {showPane ? (
            <FilesPane worktree={worktree} focus={focus} onOpenDiff={() => undefined} onQuickOpen={() => undefined} />
          ) : null}
        </FileIndexProvider>
      </RuntimeProvider>
    );
    await act(async () => root?.render(tree(true, { kind: "open", path: "src/app.ts", nonce: 1 })));
    await settle();
    await settle();
    act(() => editorView(container).dispatch({ changes: { from: 0, insert: "draft " } }));
    await act(async () => root?.render(tree(false)));
    await act(async () => root?.render(tree(true)));
    await settle();
    await settle();

    expect(editorView(container).state.doc.toString()).toBe("draft one\n");
    expect(container.querySelector(".file-tab-dirty")).not.toBeNull();
  });
});
