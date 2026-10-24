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

import { type ReviewComment, removeReviewComments, useReviewComments } from "../review/reviewComments.js";
import type { ZliBridge } from "../runtime/bridge.js";
import { RuntimeProvider } from "../runtime/RuntimeProvider.js";
import { updateAppSettings } from "../settings/appSettings.js";
import { FileIndexProvider } from "./FileIndex.js";
import { type AskAgentTarget, type FilesFocus, FilesPane } from "./FilesPane.js";

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

type Disk = Map<string, { content: string; version: string; lineEnding?: "lf" | "crlf"; binary?: boolean }>;
/** A one-pixel PNG. */
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
type Command = {
  type: string;
  path?: string;
  content?: string;
  expectedVersion?: string;
  overwrite?: boolean;
  checkpointId?: string;
};
type FakeOptions = {
  conflictOnce?: boolean;
  /** Replaces the default change state, where only src/app.ts is modified. */
  listEntries?: { path: string; status?: string; additions?: number; deletions?: number }[];
  diffs?: Record<string, string>;
  projection?: RuntimeProjection;
};

function fakeRuntime(disk: Disk, options: FakeOptions = {}) {
  const commands: Command[] = [];
  const openedLinks: string[] = [];
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
        files:
          options.listEntries ??
          [...disk.keys()].sort().map((path) => (path === "src/app.ts" ? { path, status: "modified" } : { path })),
        truncated: false,
      });
    }
    if (command.type === "files.diff") {
      return reply({
        path: command.path,
        binary: false,
        patch: options.diffs?.[command.path ?? ""] ?? "",
        truncated: false,
      });
    }
    if (command.type === "checkpoint.diff") {
      return reply({
        path: command.path,
        binary: false,
        patch: options.diffs?.[`turn:${command.path}`] ?? "",
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
        ...(file.binary ? {} : { content: file.content }),
        binary: file.binary ?? false,
        tooLarge: false,
        bom: false,
        lineEnding: file.lineEnding ?? "lf",
      };
      return reply(result);
    }
    if (command.type === "files.readData") {
      if (!path.endsWith(".png")) throw new Error(`unexpected readData ${path}`);
      return reply({ path, size: 68, version: "img1", mimeType: "image/png", dataBase64: PIXEL });
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
      getProjection: async () => options.projection ?? projection,
      onProjection: () => () => undefined,
      attachTerminal: async () => ({ accepted: true }),
      onTerminal: () => () => undefined,
    },
    app: {
      openExternal: async (url: string) => {
        openedLinks.push(url);
      },
    },
  } as unknown as ZliBridge;
  return { bridge, commands, openedLinks };
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

async function renderPane(
  bridge: ZliBridge,
  focus?: FilesFocus,
  options: { onOpenDiff?(path: string): void; askAgent?: AskAgentTarget } = {},
) {
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
              askAgent={options.askAgent}
              onOpenDiff={options.onOpenDiff ?? (() => undefined)}
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
    // Save only shows while there is something to save.
    expect(() => button(container, "Save")).toThrow();
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

describe("FilesPane layout", () => {
  afterEach(() => {
    window.localStorage.clear();
    updateAppSettings((current) => ({ ...current, fileTreePosition: "right" }));
  });

  const order = (container: HTMLElement) =>
    [...(container.querySelector(".files-body")?.children ?? [])].map((element) => element.className.split(" ")[0]);

  it("puts the open file on the left and the tree on the right by default", async () => {
    const disk: Disk = new Map([["src/app.ts", { content: "one\n", version: "v1" }]]);
    const { bridge } = fakeRuntime(disk);
    const { container } = await renderPane(bridge, { kind: "open", path: "src/app.ts", nonce: 1 });

    expect(order(container)).toEqual(["files-editor", "files-divider", "files-browser"]);
    const actions = [...container.querySelectorAll(".pane-actions button")];
    expect(actions.at(-1)?.getAttribute("aria-label")).toBe("Hide file list");
  });

  it("moves the tree to the left when the setting says so", async () => {
    updateAppSettings((current) => ({ ...current, fileTreePosition: "left" }));
    const disk: Disk = new Map([["src/app.ts", { content: "one\n", version: "v1" }]]);
    const { bridge } = fakeRuntime(disk);
    const { container } = await renderPane(bridge, { kind: "open", path: "src/app.ts", nonce: 1 });

    expect(order(container)).toEqual(["files-browser", "files-divider", "files-editor"]);
  });

  it("resizes the tree from the keyboard, remembers the width, and resets on double-click", async () => {
    const disk: Disk = new Map([["src/app.ts", { content: "one\n", version: "v1" }]]);
    const { bridge } = fakeRuntime(disk);
    const { container } = await renderPane(bridge);
    const divider = () => container.querySelector<HTMLElement>("[role=separator]");
    expect(divider()?.getAttribute("aria-valuenow")).toBe("260");

    act(() => {
      divider()?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });
    expect(divider()?.getAttribute("aria-valuenow")).toBe("276");
    expect(container.querySelector<HTMLElement>(".files-browser")?.style.width).toBe("276px");
    expect(JSON.parse(window.localStorage.getItem("zli.files.layout.v1") ?? "{}")).toMatchObject({ treeWidth: 276 });

    act(() => {
      divider()?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(divider()?.getAttribute("aria-valuenow")).toBe("260");
  });

  it("remembers that the tree was hidden", async () => {
    const disk: Disk = new Map([["src/app.ts", { content: "one\n", version: "v1" }]]);
    const { bridge } = fakeRuntime(disk);
    const first = await renderPane(bridge, { kind: "open", path: "src/app.ts", nonce: 1 });
    act(() => button(first.container, "Hide file list").click());
    expect(first.container.querySelector(".files-browser")).toBeNull();
    act(() => root?.unmount());
    root = undefined;
    document.body.replaceChildren();

    const second = await renderPane(bridge, { kind: "open", path: "src/app.ts", nonce: 2 });
    expect(second.container.querySelector(".files-browser")).toBeNull();
    expect(button(second.container, "Show file list")).toBeDefined();
  });
});

describe("FilesPane Markdown preview", () => {
  afterEach(() => window.localStorage.clear());

  /** The preview loads in its own chunk, which takes a few turns of the event loop. */
  const settlePreview = async () => {
    for (let turn = 0; turn < 6; turn += 1) await settle(20);
  };
  const tab = (container: HTMLElement, label: string) => {
    const match = [...container.querySelectorAll<HTMLButtonElement>(".file-view-tabs [role=tab]")].find(
      (candidate) => candidate.textContent === label,
    );
    if (!match) throw new Error(`No tab ${label}`);
    return match;
  };
  const editorHost = (container: HTMLElement) => container.querySelector<HTMLElement>(".file-editor-host");

  it("opens Markdown rendered, and Code only applies to the tab it was picked in", async () => {
    const disk: Disk = new Map([["README.md", { content: "# Demo\n\nHello **there**.\n", version: "r1" }]]);
    const { bridge } = fakeRuntime(disk);
    const first = await renderPane(bridge, { kind: "open", path: "README.md", nonce: 1 });
    await settlePreview();

    expect(first.container.querySelector(".file-md h1")?.textContent).toBe("Demo");
    expect(tab(first.container, "Preview").getAttribute("aria-selected")).toBe("true");
    expect(editorHost(first.container)?.hidden).toBe(true);

    act(() => tab(first.container, "Code").click());
    expect(first.container.querySelector(".file-md")).toBeNull();
    expect(editorHost(first.container)?.hidden).toBe(false);

    act(() => root?.unmount());
    root = undefined;
    document.body.replaceChildren();
    const second = await renderPane(bridge, { kind: "open", path: "README.md", nonce: 2 });
    expect(tab(second.container, "Preview").getAttribute("aria-selected")).toBe("true");
    expect(() => tab(second.container, "Split")).toThrow();
  });

  it("moves between views with the arrow keys", async () => {
    const disk: Disk = new Map([["README.md", { content: "# Demo\n", version: "r1" }]]);
    const { bridge } = fakeRuntime(disk);
    const { container } = await renderPane(bridge, { kind: "open", path: "README.md", nonce: 1 });

    act(() => {
      tab(container, "Preview").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });
    expect(tab(container, "Code").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab(container, "Code"));
    expect(container.querySelector("[role=tabpanel]")?.getAttribute("aria-labelledby")).toBe(tab(container, "Code").id);
  });

  it("shows unsaved edits from Code in the preview", async () => {
    const disk: Disk = new Map([["README.md", { content: "# Demo\n", version: "r1" }]]);
    const { bridge } = fakeRuntime(disk);
    const { container } = await renderPane(bridge, { kind: "open", path: "README.md", nonce: 1 });
    act(() => tab(container, "Code").click());

    const view = editorView(container);
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "\n## Draft\n" } }));
    await settle(100);
    await settle(200);
    act(() => tab(container, "Preview").click());
    await settlePreview();
    expect(container.querySelector(".file-md h2")?.textContent).toBe("Draft");
    expect(container.querySelector(".file-tab-dirty")).not.toBeNull();
  });

  it("opens worktree links in a tab and web links in the browser", async () => {
    const disk: Disk = new Map([
      ["docs/README.md", { content: "[Guide](guide.md) and [site](https://example.com/docs)\n", version: "r1" }],
      ["docs/guide.md", { content: "# Guide\n", version: "g1" }],
    ]);
    const { bridge, openedLinks } = fakeRuntime(disk);
    const { container } = await renderPane(bridge, { kind: "open", path: "docs/README.md", nonce: 1 });
    await settlePreview();

    act(() => container.querySelector<HTMLAnchorElement>("a[href='https://example.com/docs']")?.click());
    await settle();
    expect(openedLinks).toEqual(["https://example.com/docs"]);

    act(() => container.querySelector<HTMLAnchorElement>("a[href='guide.md']")?.click());
    await settlePreview();
    expect(container.querySelector(".file-path")?.textContent).toBe("docs/guide.md");
    expect(container.querySelector(".file-md h1")?.textContent).toBe("Guide");
  });

  it("loads images from the worktree and holds web images until asked", async () => {
    const disk: Disk = new Map([
      [
        "docs/README.md",
        { content: "![Logo](../img/logo.png)\n\n![Badge](https://example.com/b.svg)\n", version: "r1" },
      ],
    ]);
    const { bridge, commands } = fakeRuntime(disk);
    const { container } = await renderPane(bridge, { kind: "open", path: "docs/README.md", nonce: 1 });
    await settlePreview();

    expect(commands.find((command) => command.type === "files.readData")?.path).toBe("img/logo.png");
    expect(container.querySelector<HTMLImageElement>("img[alt=Logo]")?.getAttribute("src")).toBe(
      `data:image/png;base64,${PIXEL}`,
    );
    const badge = () => container.querySelector<HTMLImageElement>("img[alt=Badge]");
    expect(badge()?.getAttribute("src")).toBeNull();
    expect(container.querySelector(".file-md-notice")?.textContent).toContain("1 web image is not loaded");

    act(() => button(container, "Load web images").click());
    expect(badge()?.getAttribute("src")).toBe("https://example.com/b.svg");
  });

  it("jumps to the source line in Code when a block is double-clicked", async () => {
    const disk: Disk = new Map([["README.md", { content: "# Demo\n\nFirst\n\nSecond\n", version: "r1" }]]);
    const { bridge } = fakeRuntime(disk);
    const { container } = await renderPane(bridge, { kind: "open", path: "README.md", nonce: 1 });
    await settlePreview();

    const second = [...container.querySelectorAll<HTMLElement>(".file-md p")].find((p) => p.textContent === "Second");
    act(() => {
      second?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    await settle(50);
    expect(tab(container, "Code").getAttribute("aria-selected")).toBe("true");
    const view = editorView(container);
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(5);
  });
});

describe("FilesPane changes", () => {
  const changedEntries = [
    { path: "README.md" },
    { path: "src/app.ts", status: "modified", additions: 2, deletions: 1 },
    { path: "src/new.ts", status: "untracked" },
  ];

  it("lists changed files in a group above the tree, with line counts", async () => {
    const disk: Disk = new Map([
      ["README.md", { content: "# Demo\n", version: "r1" }],
      ["src/app.ts", { content: "const a = 2;\n", version: "v1" }],
      ["src/new.ts", { content: "new\n", version: "n1" }],
    ]);
    const { bridge } = fakeRuntime(disk, { listEntries: changedEntries });
    const { container } = await renderPane(bridge);

    const header = container.querySelector<HTMLButtonElement>(".file-group-header");
    expect(header?.textContent).toBe("Changed2");
    expect(header?.getAttribute("aria-expanded")).toBe("true");
    const grouped = () => [...container.querySelectorAll<HTMLButtonElement>("[data-group=changed]")];
    expect(grouped().map((row) => row.dataset.path)).toEqual(["src/app.ts", "src/new.ts"]);
    expect(grouped()[0]?.querySelector(".file-counts")?.getAttribute("aria-label")).toBe("2 added, 1 removed");
    expect(grouped()[1]?.querySelector(".file-counts")).toBeNull();

    act(() => grouped()[0]?.click());
    await settle();
    await settle();
    expect(editorView(container).state.doc.toString()).toBe("const a = 2;\n");
    expect(container.querySelector(".file-path-bar .file-counts")?.textContent).toBe("+2−1");

    act(() => header?.click());
    expect(grouped()).toHaveLength(0);
    act(() => button(container, "Changed 2").click());
    expect(container.querySelector(".file-group-header")).toBeNull();
  });

  it("shows the file's diff in place of its contents and switches to the last agent turn", async () => {
    const disk: Disk = new Map([["src/app.ts", { content: "const a = 2;\n", version: "v1" }]]);
    const checkpointId = "00000000-0000-4000-8000-000000000077";
    const { bridge, commands } = fakeRuntime(disk, {
      listEntries: [{ path: "src/app.ts", status: "modified", additions: 1, deletions: 1 }],
      diffs: {
        "src/app.ts": "@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n",
        "turn:src/app.ts": "@@ -1 +1 @@\n-const a = 0;\n+const a = 1;\n",
      },
      projection: {
        ...projection,
        checkpoints: [
          {
            checkpointId,
            threadId: "00000000-0000-4000-8000-000000000033",
            worktreeId: worktree.worktreeId,
            turnId: "turn-1",
            startTree: "a".repeat(40),
            endTree: "b".repeat(40),
            files: [{ path: "src/app.ts", kind: "modified", additions: 1, deletions: 1, binary: false }],
            fileCount: 1,
            additions: 1,
            deletions: 1,
          },
        ] as RuntimeProjection["checkpoints"],
      },
    });
    const opened: string[] = [];
    const { container } = await renderPane(
      bridge,
      { kind: "open", path: "src/app.ts", nonce: 1 },
      { onOpenDiff: (path) => opened.push(path) },
    );

    act(() => button(container, "Diff").click());
    await settle();
    await settle();
    expect(commands.find((command) => command.type === "files.diff")?.path).toBe("src/app.ts");
    const diffText = () => container.querySelector(".file-diff .diff-lines")?.textContent ?? "";
    expect(diffText()).toContain("+const a = 2;");
    expect(container.querySelector(".file-body-host")?.hasAttribute("hidden")).toBe(true);
    expect(button(container, "Diff").getAttribute("aria-pressed")).toBe("true");

    act(() => button(container, "Last turn").click());
    await settle();
    await settle();
    expect(commands.find((command) => command.type === "checkpoint.diff")).toMatchObject({
      checkpointId,
      path: "src/app.ts",
    });
    expect(diffText()).toContain("+const a = 1;");

    act(() => button(container, "Open in Changes").click());
    expect(opened).toEqual(["src/app.ts"]);

    act(() => button(container, "Diff").click());
    expect(container.querySelector(".file-diff")).toBeNull();
    expect(editorView(container).state.doc.toString()).toBe("const a = 2;\n");
  });

  it("keeps Last turn unavailable when no agent turn changed the file", async () => {
    const disk: Disk = new Map([["src/app.ts", { content: "const a = 2;\n", version: "v1" }]]);
    const { bridge, commands } = fakeRuntime(disk, {
      listEntries: [{ path: "src/app.ts", status: "modified", additions: 1, deletions: 1 }],
    });
    const { container } = await renderPane(bridge, { kind: "open", path: "src/app.ts", nonce: 1 });

    act(() => button(container, "Diff").click());
    await settle();
    await settle();
    const lastTurn = button(container, "Last turn");
    expect(lastTurn.getAttribute("aria-disabled")).toBe("true");
    act(() => lastTurn.click());
    await settle();
    expect(commands.some((command) => command.type === "checkpoint.diff")).toBe(false);
    expect(container.querySelector(".file-diff .empty-state")?.textContent).toContain("No uncommitted changes");
  });
});

describe("FilesPane image preview", () => {
  it("shows an image file with its size, and switches between fitted and actual size", async () => {
    const disk: Disk = new Map([["img/logo.png", { content: "", version: "img1", binary: true }]]);
    const { bridge, commands } = fakeRuntime(disk);
    const { container } = await renderPane(bridge, { kind: "open", path: "img/logo.png", nonce: 1 });

    const image = container.querySelector<HTMLImageElement>(".file-image img");
    expect(image?.getAttribute("src")).toBe(`data:image/png;base64,${PIXEL}`);
    expect(image?.alt).toBe("logo.png");
    expect(commands.filter((command) => command.type === "files.readData").map((command) => command.path)).toEqual([
      "img/logo.png",
    ]);
    expect(container.querySelector(".file-image-meta")?.textContent).toBe("68 bytes");

    const toggle = button(container, "Actual size");
    act(() => toggle.click());
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.textContent).toBe("Fit to panel");
    expect(container.querySelector(".file-image-stage")?.classList.contains("is-actual")).toBe(true);
  });
});

describe("FilesPane Ask agent", () => {
  it("adds the selected lines with Mod+L or the button, and a whole file from the tree menu", async () => {
    const disk: Disk = new Map([["src/app.ts", { content: "one\ntwo\nthree\n", version: "v1" }]]);
    const { bridge } = fakeRuntime(disk);
    const asked: unknown[] = [];
    const askAgent: AskAgentTarget = { name: "Droid", ask: (reference) => asked.push(reference) };
    const { container } = await renderPane(bridge, { kind: "open", path: "src/app.ts", nonce: 1 }, { askAgent });

    const view = editorView(container);
    act(() => view.dispatch({ selection: { anchor: 4, head: 13 } }));
    act(() => {
      view.contentDOM.dispatchEvent(
        new KeyboardEvent("keydown", { key: "l", code: "KeyL", ctrlKey: true, bubbles: true }),
      );
    });
    const lines = { path: "src/app.ts", startLine: 2, endLine: 3, snippet: "two\nthree" };
    expect(asked).toEqual([lines]);

    act(() => button(container, "Ask Droid about this").click());
    expect(asked.at(-1)).toEqual(lines);

    const row = container.querySelector<HTMLElement>('[data-tree-row][data-path="src/app.ts"]:not([data-group])');
    act(() => {
      row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 50 }));
    });
    const menu = document.querySelector<HTMLElement>(".files-menu");
    expect(menu?.getAttribute("aria-label")).toBe("Actions for app.ts");
    expect([...(menu?.querySelectorAll("[role=menuitem]") ?? [])].map((item) => item.textContent)).toEqual([
      "Add to Droid chat",
      "Open",
      "Copy path",
      "Copy full path",
    ]);
    act(() => button(document.body, "Add to Droid chat").click());
    expect(asked.at(-1)).toEqual({ path: "src/app.ts" });
    expect(document.querySelector(".files-menu")).toBeNull();
  });

  it("explains why asking is unavailable without an agent chat", async () => {
    const disk: Disk = new Map([["src/app.ts", { content: "one\n", version: "v1" }]]);
    const { bridge } = fakeRuntime(disk);
    const { container } = await renderPane(bridge, { kind: "open", path: "src/app.ts", nonce: 1 });

    const ask = button(container, "Ask an agent about this");
    expect(ask.disabled).toBe(true);
    expect(ask.dataset.tooltip).toBe("Start a chat with an agent in this worktree to ask about code");

    const host = container.querySelector<HTMLElement>(".file-editor-host");
    act(() => {
      host?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    });
    const editorMenu = document.querySelector<HTMLElement>(".files-menu");
    if (!editorMenu) throw new Error("No menu");
    const [item] = editorMenu.querySelectorAll<HTMLElement>("[role=menuitem]");
    expect(item?.firstElementChild?.textContent).toBe("Ask an agent about this");
    expect(item?.getAttribute("aria-disabled")).toBe("true");
    expect(item?.title).toBe("Start a chat with an agent in this worktree to ask about code");
    act(() => {
      editorMenu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.querySelector(".files-menu")).toBeNull();
  });
});

describe("FilesPane review notes", () => {
  it("adds a note on the selected lines, or on the cursor line, to the review comments", async () => {
    const disk: Disk = new Map([["src/app.ts", { content: "one\ntwo\nthree\n", version: "v1" }]]);
    const { bridge } = fakeRuntime(disk);
    const { container } = await renderPane(bridge, { kind: "open", path: "src/app.ts", nonce: 1 });
    let notes: readonly ReviewComment[] = [];
    function Probe() {
      notes = useReviewComments(worktree.worktreeId);
      return null;
    }
    const probeHost = document.createElement("div");
    const probe = createRoot(probeHost);
    act(() => probe.render(<Probe />));

    const view = editorView(container);
    act(() => view.dispatch({ selection: { anchor: 4, head: 13 } }));
    act(() => button(container, "Add review note").click());
    const textarea = container.querySelector<HTMLTextAreaElement>(".file-note textarea");
    expect(textarea?.getAttribute("aria-label")).toBe("Note on src/app.ts:2-3");
    expect(document.activeElement).toBe(textarea);
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    act(() => {
      setValue?.call(textarea, "Rename these");
      textarea?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => button(container, "Add note").click());
    expect(container.querySelector(".file-note")).toBeNull();
    expect(notes.map(({ path, anchor, excerpt, body }) => ({ path, anchor, excerpt, body }))).toEqual([
      {
        path: "src/app.ts",
        anchor: { side: "new", start: 2, end: 3 },
        excerpt: [" two", " three"],
        body: "Rename these",
      },
    ]);

    act(() => view.dispatch({ selection: { anchor: 1 } }));
    act(() => button(container, "Add review note").click());
    expect(container.querySelector(".file-note-location")?.textContent).toBe("Note on src/app.ts:1");
    act(() => {
      container
        .querySelector(".file-note textarea")
        ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(container.querySelector(".file-note")).toBeNull();
    expect(notes).toHaveLength(1);

    act(() => removeReviewComments(notes.map((note) => note.id)));
    act(() => probe.unmount());
  });
});
