// @vitest-environment jsdom

import {
  BrowserProfileId,
  BrowserTabId,
  type BrowserTabProjection,
  CommandId,
  EnvironmentId,
  ProjectId,
  type RuntimeProjection,
  type TerminalProjection,
  type ThreadProjection,
  WorktreeId,
  type WorktreeProjection,
} from "@zli-v2/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ZliBridge } from "../runtime/bridge.js";
import { RuntimeProvider } from "../runtime/RuntimeProvider.js";
import { BrowserPane, type BrowserReveal } from "./BrowserPane.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const worktree = {
  worktreeId: WorktreeId.parse("00000000-0000-4000-8000-000000000011"),
  projectId: ProjectId.parse("00000000-0000-4000-8000-000000000010"),
  path: "C:/repo",
  branch: "main",
  status: "ready" as const,
};

const baseTab: BrowserTabProjection = {
  browserTabId: BrowserTabId.parse("00000000-0000-4000-8000-000000000021"),
  profileId: BrowserProfileId.parse("00000000-0000-4000-8000-000000000002"),
  worktreeId: worktree.worktreeId,
  url: "http://127.0.0.1:5173/",
  title: "Dev server",
  active: true,
  status: "idle",
};

const otherTab: BrowserTabProjection = {
  ...baseTab,
  browserTabId: BrowserTabId.parse("00000000-0000-4000-8000-000000000022"),
  url: "http://127.0.0.1:5173/checkout",
  title: "Checkout",
  active: false,
};

const threadId = "00000000-0000-4000-8000-000000000401";
const chatAgent = {
  threadId,
  worktreeId: worktree.worktreeId,
  provider: "codex",
  status: "idle",
  capabilities: {},
  updatedAt: "2026-01-01T00:00:00.000Z",
} as ThreadProjection;

/** Other worktrees and terminals in the runtime, and an error the runtime answers commands with. */
type More = { worktrees?: WorktreeProjection[]; terminals?: TerminalProjection[]; reject?: string };

function projectionWith(
  tab: BrowserTabProjection,
  extra: BrowserTabProjection[] = [],
  threads: ThreadProjection[] = [],
  more: More = {},
): RuntimeProjection {
  return {
    environment: {
      environmentId: EnvironmentId.parse("00000000-0000-4000-8000-000000000001"),
      label: "Local",
      protocolVersion: 1,
      capabilities: { worktrees: true, terminals: true, browser: true, eventReplay: true },
    },
    projects: [{ projectId: worktree.projectId, path: "C:/repo", name: "repo" }],
    worktrees: [worktree, ...(more.worktrees ?? [])],
    threads,
    terminals: more.terminals ?? [],
    browserTabs: [tab, ...extra],
    attention: [],
    lastSequence: 1,
  };
}

function createBridge(
  initial: BrowserTabProjection,
  extra: BrowserTabProjection[] = [],
  threads: ThreadProjection[] = [],
  more: More = {},
) {
  let current = initial;
  let projectionListener: ((projection: RuntimeProjection) => void) | undefined;
  const calls: string[] = [];
  const dispatched: Array<{ command: Record<string, unknown> }> = [];
  const bridge: ZliBridge = {
    runtime: {
      dispatch: async (request) => {
        dispatched.push(request as { command: Record<string, unknown> });
        const commandId = CommandId.parse("00000000-0000-4000-8000-000000000099");
        if (more.reject)
          return {
            commandId,
            accepted: false as const,
            error: { code: "unavailable" as const, message: more.reject, retryable: false },
          };
        return { commandId, accepted: true };
      },
      getProjection: async () => projectionWith(current, extra, threads, more),
      onProjection: (listener) => {
        projectionListener = listener;
        return () => undefined;
      },
      attachTerminal: async () => ({ accepted: true }),
      onTerminal: () => () => undefined,
    },
    browser: {
      create: vi.fn(async (input: unknown) => {
        const requested = (input as { browserTabId?: string }).browserTabId;
        return extra.find((candidate) => candidate.browserTabId === requested) ?? current;
      }),
      close: async () => undefined,
      activate: vi.fn(async (browserTabId: string) => {
        calls.push("activate");
        return extra.find((candidate) => candidate.browserTabId === browserTabId) ?? current;
      }),
      navigate: async () => current,
      hide: vi.fn(async () => {
        calls.push("hide");
      }),
      setBounds: vi.fn(async () => {
        calls.push("bounds");
      }),
      back: async () => undefined,
      forward: async () => undefined,
      reload: async () => undefined,
      stop: async () => undefined,
      openDevTools: vi.fn(async () => undefined),
      setViewport: vi.fn(async () => current),
      onReveal: () => () => undefined,
      snapshot: async () => undefined,
      click: async () => undefined,
      fill: async () => undefined,
      press: async () => undefined,
      waitForNetworkIdle: async () => ({ idle: true }),
      screenshot: async () => undefined,
      inspectElement: async () => undefined,
      designInspect: async () => undefined,
      consoleEntries: async () => [],
      networkEntries: async () => [],
    },
    dialog: {
      openProject: async () => undefined,
      saveSupportBundle: async () => undefined,
      openLegacySnapshot: async () => undefined,
    },
    menu: { trigger: async () => undefined },
    app: { getVersion: async () => "0.0.0", quit: async () => undefined },
  };
  return {
    bridge,
    calls,
    dispatched,
    publish(next: BrowserTabProjection) {
      current = next;
      projectionListener?.(projectionWith(next, extra, threads, more));
    },
  };
}

let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  window.localStorage.clear();
});

async function renderPane(
  bridge: ZliBridge,
  obscured: boolean,
  reveal?: BrowserReveal,
  callbacks: Pick<Parameters<typeof BrowserPane>[0], "onNotice" | "onShowAgent"> = {},
) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <RuntimeProvider bridge={bridge}>
        <BrowserPane worktree={worktree} obscured={obscured} reveal={reveal} {...callbacks} />
      </RuntimeProvider>,
    );
  });
  return {
    container,
    rerender: async (nextObscured: boolean) => {
      await act(async () => {
        root?.render(
          <RuntimeProvider bridge={bridge}>
            <BrowserPane worktree={worktree} obscured={nextObscured} />
          </RuntimeProvider>,
        );
      });
    },
  };
}

describe("BrowserPane", () => {
  it("hides the native view while obscured and on unmount, and shows it again with fresh bounds", async () => {
    const fake = createBridge(baseTab);
    const view = await renderPane(fake.bridge, false);
    expect(fake.bridge.browser.activate).toHaveBeenCalled();
    expect(fake.calls.at(-1)).toBe("activate");

    fake.calls.length = 0;
    await view.rerender(true);
    expect(fake.calls).toContain("hide");
    expect(fake.calls).not.toContain("activate");

    fake.calls.length = 0;
    await view.rerender(false);
    expect(fake.calls).toEqual(["bounds", "activate"]);

    fake.calls.length = 0;
    act(() => root?.unmount());
    root = undefined;
    expect(fake.calls).toEqual(["hide"]);
  });

  it("keeps the address bar in sync with in-page navigation unless the user is typing", async () => {
    const fake = createBridge(baseTab);
    const { container } = await renderPane(fake.bridge, false);
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Browser URL"]');
    expect(input?.value).toBe("http://127.0.0.1:5173/");

    await act(async () => {
      fake.publish({ ...baseTab, url: "http://127.0.0.1:5173/settings" });
    });
    expect(input?.value).toBe("http://127.0.0.1:5173/settings");

    await act(async () => {
      input?.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "example.com");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      fake.publish({ ...baseTab, url: "http://127.0.0.1:5173/profile" });
    });
    expect(input?.value).toBe("example.com");
  });

  it("previews the page at a device size and returns to the panel size", async () => {
    const fake = createBridge(baseTab);
    const { container } = await renderPane(fake.bridge, false);
    const deviceButton = container.querySelector<HTMLButtonElement>('button[aria-label="Device size"]');
    await act(async () => {
      deviceButton?.click();
    });
    expect(fake.bridge.browser.setViewport).toHaveBeenLastCalledWith(
      baseTab.browserTabId,
      expect.objectContaining({ width: 393, height: 852, mobile: true }),
    );

    await act(async () => {
      fake.publish({ ...baseTab, viewport: { width: 393, height: 852, deviceScaleFactor: 3, mobile: true } });
    });
    expect(container.querySelector(".browser-device-size")?.textContent).toContain("393 × 852");
    expect(deviceButton?.getAttribute("aria-pressed")).toBe("true");

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Rotate"]')?.click();
    });
    expect(fake.bridge.browser.setViewport).toHaveBeenLastCalledWith(
      baseTab.browserTabId,
      expect.objectContaining({ width: 852, height: 393 }),
    );

    await act(async () => {
      deviceButton?.click();
    });
    expect(fake.bridge.browser.setViewport).toHaveBeenLastCalledWith(baseTab.browserTabId, null);
  });

  it("opens DevTools for the current tab", async () => {
    const fake = createBridge(baseTab);
    const { container } = await renderPane(fake.bridge, false);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Open browser developer tools"]')?.click();
    });
    expect(fake.bridge.browser.openDevTools).toHaveBeenCalledWith(baseTab.browserTabId);
  });

  it("brings a tab an agent opened to the front instead of the last active one", async () => {
    const fake = createBridge(baseTab, [otherTab]);
    const { container } = await renderPane(fake.bridge, false, {
      browserTabId: otherTab.browserTabId,
      worktreeId: worktree.worktreeId,
      key: 1,
    });
    expect(fake.bridge.browser.activate).toHaveBeenCalledWith(otherTab.browserTabId);
    expect(fake.bridge.browser.activate).not.toHaveBeenCalledWith(baseTab.browserTabId);
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Browser URL"]')?.value).toBe(otherTab.url);
  });

  it("hides Annotate without the desktop design mode bridge", async () => {
    const fake = createBridge(baseTab);
    const { container } = await renderPane(fake.bridge, false);
    expect(container.querySelector('button[aria-label="Device size"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Annotate"]')).toBeNull();
  });

  it("keeps Annotate on across picks, takes each note from the page, and sends them in one message", async () => {
    const fake = createBridge(baseTab);
    const design = withAnnotate(fake.bridge);
    const { container } = await renderPane(fake.bridge, false);
    const annotate = buttonNamed(container, "Annotate");
    await act(async () => {
      annotate?.click();
    });
    expect(design.designPick).toHaveBeenCalledWith(baseTab.browserTabId);
    expect(annotate?.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector('input[aria-label="Browser URL"]')).toBeNull();
    expect(container.querySelector(".browser-annotate-hint")?.textContent).toContain("Click or drag");

    await design.answer({ kind: "element", id: "a-1", selector: "#save" });
    expect(design.designInspect).toHaveBeenCalledWith({ browserTabId: baseTab.browserTabId, selector: "#save" });
    expect(annotate?.getAttribute("aria-pressed")).toBe("true");
    await design.answer({ kind: "mode", mode: "note" });
    expect(container.querySelector(".browser-annotate-hint")?.textContent).toContain("Return to save");
    const send = () => buttonNamed(container, "Send 1 annotation");
    expect(send()?.textContent).toBe("1Send");
    expect(send()?.disabled).toBe(true);
    await design.answer({ kind: "note", id: "a-1", instruction: "Make it green." });
    await design.answer({ kind: "mode", mode: "select" });
    expect(send()?.disabled).toBe(false);

    await design.answer({ kind: "element", id: "a-2", selector: "h1" });
    await design.answer({ kind: "note", id: "a-2", instruction: "Bigger, tighter." });
    expect(design.designPick).toHaveBeenCalledTimes(7);
    const panel = container.querySelector('[aria-label="Annotations"]');
    expect(panel?.textContent).toContain("2 annotations");
    expect(panel?.textContent).toContain('<button> "Save"');
    expect(panel?.textContent).toContain("Make it green.");
    expect(panel?.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,aGVsbG8=");
    expect(design.designMark).toHaveBeenLastCalledWith({
      browserTabId: baseTab.browserTabId,
      marks: [
        { kind: "element", id: "a-1", n: 1, selector: "#save", note: "Make it green." },
        { kind: "element", id: "a-2", n: 2, selector: "h1", note: "Bigger, tighter." },
      ],
    });

    fake.calls.length = 0;
    await act(async () => {
      buttonNamed(container, "Send 2 annotations")?.click();
    });
    expect(fake.calls).toContain("hide");
    const dialog = document.querySelector('[role="dialog"][aria-label="Send annotations"]');
    const preview = dialog?.querySelector(".send-preview")?.textContent ?? "";
    expect(preview).toContain("Please apply these 2 design annotations I made in the ZLI browser panel");
    expect(preview).toContain('### Annotation 1: <button> "Save"\nSelector: `#save`\nInstruction: Make it green.');
    expect(preview).toContain("### Annotation 2: <h1>");
    expect(preview).toContain("Instruction: Bigger, tighter.");
  });

  it("sends the annotations to the only agent in one click, clears them, and confirms it", async () => {
    const fake = createBridge(baseTab, [], [chatAgent]);
    const design = withAnnotate(fake.bridge);
    const onNotice = vi.fn();
    const onShowAgent = vi.fn();
    const { container } = await renderPane(fake.bridge, false, undefined, { onNotice, onShowAgent });
    const annotate = buttonNamed(container, "Annotate");
    await act(async () => {
      annotate?.click();
    });
    await design.answer({ kind: "element", id: "a-1", selector: "#save" });
    await design.answer({ kind: "note", id: "a-1", instruction: "Make it green." });
    const send = () => buttonNamed(container, "Send 1 annotation");
    await vi.waitFor(() =>
      expect(send()?.getAttribute("data-tooltip")).toBe("Send to Codex. Shift+click to edit it first."),
    );

    // Shift+click opens the dialog to read the message first, with the native view out of its way.
    fake.calls.length = 0;
    await act(async () => {
      send()?.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    });
    const dialog = document.querySelector('[role="dialog"][aria-label="Send annotations"]');
    expect(dialog?.querySelector(".choice-detail")?.textContent).toBe("Codex chat · Ready");
    expect(dialog?.querySelector(".send-preview")?.textContent).toContain("Instruction: Make it green.");
    expect(fake.calls).toContain("hide");
    await act(async () => {
      dialog && buttonNamed(dialog, "Cancel")?.click();
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(fake.dispatched).toHaveLength(0);

    await act(async () => {
      send()?.click();
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(fake.dispatched.at(-1)?.command).toMatchObject({
      type: "thread.queue",
      threadId,
      attachments: [expect.objectContaining({ name: "element-1.png" })],
    });
    expect(String(fake.dispatched.at(-1)?.command.text)).toContain("Instruction: Make it green.");
    expect(container.querySelector('[aria-label="Annotations"]')).toBeNull();
    expect(send()).toBeUndefined();
    expect(annotate?.getAttribute("aria-pressed")).toBe("false");
    expect(onNotice).toHaveBeenCalledWith({
      message: "Sent to Codex.",
      action: { label: "Show", run: expect.any(Function) },
    });
    expect(onShowAgent).not.toHaveBeenCalled();
    onNotice.mock.calls[0]?.[0].action.run();
    expect(onShowAgent).toHaveBeenCalledWith(threadId, "chat");
  });

  it("hides the native view while the send menu is open and edits the message from it", async () => {
    const fake = createBridge(baseTab, [], [chatAgent]);
    const design = withAnnotate(fake.bridge);
    const { container } = await renderPane(fake.bridge, false);
    await act(async () => {
      buttonNamed(container, "Annotate")?.click();
    });
    await design.answer({ kind: "element", id: "a-1", selector: "#save" });
    await design.answer({ kind: "note", id: "a-1", instruction: "Make it green." });
    await vi.waitFor(() => expect(buttonNamed(container, "Send 1 annotation")?.dataset.tooltip).toContain("Codex"));
    fake.calls.length = 0;
    await act(async () => {
      buttonNamed(container, "Choose agent")?.click();
    });
    expect(fake.calls).toContain("hide");
    const items = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role^="menuitem"]')];
    expect(items.map((item) => item.textContent)).toEqual(["Codex", "Edit message before sending…"]);
    expect(items[0]?.getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      items[1]?.click();
    });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.querySelector('[role="dialog"][aria-label="Send annotations"]')).not.toBeNull();
    expect(fake.dispatched).toHaveLength(0);
  });

  it("adds a drawn region with its sketch and note to the message", async () => {
    const fake = createBridge(baseTab);
    const design = withAnnotate(fake.bridge);
    const { container } = await renderPane(fake.bridge, false);
    await act(async () => {
      buttonNamed(container, "Annotate")?.click();
    });
    const region = {
      kind: "region",
      id: "a-1",
      bounds: { x: 40, y: 60, width: 300, height: 120 },
      viewport: { width: 1280, height: 720 },
      strokes: [{ tool: "pen", points: [50, 70, 60, 80] }],
      instruction: "Add a signup card here",
    };
    await design.answer(region);
    expect(design.designCapture).toHaveBeenCalledWith({
      browserTabId: baseTab.browserTabId,
      bounds: region.bounds,
      strokes: region.strokes,
    });
    const panel = container.querySelector('[aria-label="Annotations"]');
    expect(panel?.textContent).toContain("Region");
    expect(panel?.textContent).toContain("1 mark");
    expect(panel?.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,cmVnaW9u");
    expect(design.designMark).toHaveBeenLastCalledWith({
      browserTabId: baseTab.browserTabId,
      marks: [
        { kind: "region", id: "a-1", n: 1, bounds: region.bounds, strokes: region.strokes, note: region.instruction },
      ],
    });
    await act(async () => {
      buttonNamed(container, "Send 1 annotation")?.click();
    });
    const preview = document.querySelector('[aria-label="Send annotations"] .send-preview')?.textContent ?? "";
    expect(preview).toContain("### Annotation 1: Region");
    expect(preview).toContain("Bounds: x 40, y 60, 300 × 120 px in page coordinates (viewport 1280 × 720)");
    expect(preview).toContain("Instruction: Add a signup card here");
    expect(preview).toContain("Sketch: region-1.png (attached; the red marks are my drawing)");
  });

  it("exits Annotate with Escape and keeps the annotations until they are sent or cleared", async () => {
    const fake = createBridge(baseTab);
    const design = withAnnotate(fake.bridge);
    const { container } = await renderPane(fake.bridge, false);
    const annotate = buttonNamed(container, "Annotate");
    await act(async () => {
      annotate?.click();
    });
    await design.answer({ kind: "element", id: "a-1", selector: "#save" });
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(design.designCancel).toHaveBeenCalledWith(baseTab.browserTabId);
    expect(annotate?.getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector(".browser-annotate-hint")).toBeNull();
    expect(container.querySelector('input[aria-label="Browser URL"]')).not.toBeNull();
    const panel = () => container.querySelector('[aria-label="Annotations"]');
    expect(panel()?.textContent).toContain("1 annotation");
    expect(panel()?.textContent).toContain("Turn on Annotate to edit notes on the page.");

    // Escape in the page ends the session the same way.
    await act(async () => {
      annotate?.click();
    });
    expect(annotate?.getAttribute("aria-pressed")).toBe("true");
    design.designCancel.mockClear();
    await design.answer(null);
    expect(annotate?.getAttribute("aria-pressed")).toBe("false");
    expect(design.designCancel).toHaveBeenCalledWith(baseTab.browserTabId);

    await act(async () => {
      buttonNamed(container, "Clear all")?.click();
    });
    expect(panel()).toBeNull();
    expect(buttonNamed(container, "Send 1 annotation")).toBeUndefined();
  });

  it("keeps text and CSS edits made on the page and sends them as changes to make in code", async () => {
    const fake = createBridge(baseTab);
    const design = withAnnotate(fake.bridge);
    const { container } = await renderPane(fake.bridge, false);
    await act(async () => {
      buttonNamed(container, "Annotate")?.click();
    });
    await design.answer({ kind: "element", id: "a-1", selector: "#save" });
    await design.answer({
      kind: "note",
      id: "a-1",
      instruction: "",
      edits: {
        text: { from: "Save", to: "Save all" },
        css: [{ property: "background-color", from: "rgb(0, 0, 255)", to: "green" }],
      },
    });
    expect(container.querySelector(".browser-design-edits")?.textContent).toBe("1 CSS edit · text");
    expect(design.designMark).toHaveBeenLastCalledWith({
      browserTabId: baseTab.browserTabId,
      marks: [
        {
          kind: "element",
          id: "a-1",
          n: 1,
          selector: "#save",
          preview: { text: "Save all", styles: { "background-color": "green" } },
        },
      ],
    });
    const send = buttonNamed(container, "Send 1 annotation");
    expect(send?.disabled).toBe(false);
    await act(async () => {
      send?.click();
    });
    const preview = document.querySelector('[aria-label="Send annotations"] .send-preview')?.textContent ?? "";
    expect(preview).toContain('Text: "Save" → "Save all"');
    expect(preview).toContain("CSS: background-color: rgb(0, 0, 255) → green");
  });

  it("closes the page's note when an element cannot be read and removes pins deleted on the page", async () => {
    const fake = createBridge(baseTab);
    const design = withAnnotate(fake.bridge);
    const { container } = await renderPane(fake.bridge, false);
    await act(async () => {
      buttonNamed(container, "Annotate")?.click();
    });
    await design.answer({ kind: "element", id: "a-1", selector: "#gone" });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("The element could not be read.");
    expect(design.designMark).toHaveBeenCalledWith({ browserTabId: baseTab.browserTabId, marks: [], drop: ["a-1"] });

    await design.answer({ kind: "element", id: "a-2", selector: "#save" });
    expect(container.querySelector('[aria-label="Annotations"]')?.textContent).toContain("1 annotation");
    await design.answer({ kind: "remove", id: "a-2" });
    expect(container.querySelector('[aria-label="Annotations"]')).toBeNull();
    expect(buttonNamed(container, "Annotate")?.getAttribute("aria-pressed")).toBe("true");
  });
  it("shows a page load failure reported by the tab", async () => {
    const fake = createBridge({
      ...baseTab,
      status: "crashed",
      loadError: "Could not load http://127.0.0.1:5173/: ERR_CONNECTION_REFUSED",
    });
    const { container } = await renderPane(fake.bridge, false);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("ERR_CONNECTION_REFUSED");
  });
});

describe("BrowserPane sending to other worktrees", () => {
  const foia = {
    ...worktree,
    worktreeId: WorktreeId.parse("00000000-0000-4000-8000-000000000012"),
    path: "C:/repo-foia",
    branch: "cursor-foia",
  };
  const elsewhereProject = {
    ...worktree,
    worktreeId: WorktreeId.parse("00000000-0000-4000-8000-000000000013"),
    projectId: ProjectId.parse("00000000-0000-4000-8000-000000000020"),
    path: "C:/elsewhere",
    branch: "other-project",
  };
  const foiaThreadId = "00000000-0000-4000-8000-000000000402";
  const foiaAgent = { ...chatAgent, threadId: foiaThreadId, worktreeId: foia.worktreeId } as ThreadProjection;
  const strangerAgent = {
    ...chatAgent,
    threadId: "00000000-0000-4000-8000-000000000403",
    worktreeId: elsewhereProject.worktreeId,
  } as ThreadProjection;
  const worktrees = [foia, elsewhereProject];

  async function annotateOne(container: HTMLElement, design: ReturnType<typeof withAnnotate>) {
    await act(async () => {
      buttonNamed(container, "Annotate")?.click();
    });
    await design.answer({ kind: "element", id: "a-1", selector: "#save" });
    await design.answer({ kind: "note", id: "a-1", instruction: "Make it green." });
  }

  it("asks which agent to use when only other worktrees have one, and tells it where the page came from", async () => {
    const fake = createBridge(baseTab, [], [foiaAgent, strangerAgent], { worktrees });
    const design = withAnnotate(fake.bridge);
    const onNotice = vi.fn();
    const onShowAgent = vi.fn();
    const { container } = await renderPane(fake.bridge, false, undefined, { onNotice, onShowAgent });
    await annotateOne(container, design);
    const send = () => buttonNamed(container, "Send 1 annotation");
    await vi.waitFor(() =>
      expect(send()?.dataset.tooltip).toBe("No agent is running here. Pick one in another worktree."),
    );

    await act(async () => {
      send()?.click();
    });
    expect(fake.dispatched).toHaveLength(0);
    const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Send annotations"]');
    expect(dialog?.textContent).toContain("from main to an agent in this project");
    expect(dialog?.textContent).toContain("No agent is running in main. Pick one from another worktree.");
    const groups = [...(dialog?.querySelectorAll('[role="radiogroup"] fieldset legend') ?? [])];
    expect(groups.map((legend) => legend.textContent)).toEqual(["cursor-foia"]);
    const radios = [...(dialog?.querySelectorAll<HTMLInputElement>('input[type="radio"]') ?? [])];
    expect(radios).toHaveLength(1);
    expect(radios[0]?.checked).toBe(false);
    const sendButton = () => (dialog ? buttonNamed(dialog, "Send") : undefined);
    expect(sendButton()?.disabled).toBe(true);

    await act(async () => {
      radios[0]?.click();
    });
    expect(dialog?.querySelector(".send-elsewhere")?.textContent).toBe(
      "Codex works on cursor-foia. The page was annotated on main.",
    );
    const context =
      "This annotation was made in the browser of another worktree, main at C:/repo, on http://127.0.0.1:5173/. " +
      "You work on cursor-foia, and your checkout may differ from that one, so make the change in your own worktree.";
    expect(dialog?.querySelector(".send-preview")?.textContent).toMatch(
      new RegExp(`^${escapeRegExp(context)}\n\nPlease apply this design annotation`, "u"),
    );
    await act(async () => {
      sendButton()?.click();
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(fake.dispatched.at(-1)?.command).toMatchObject({ type: "thread.queue", threadId: foiaThreadId });
    expect(String(fake.dispatched.at(-1)?.command.text).startsWith(context)).toBe(true);
    expect(container.querySelector('[aria-label="Annotations"]')).toBeNull();
    // The person stays on the page; the notice brings the agent forward when they want.
    expect(onShowAgent).not.toHaveBeenCalled();
    expect(onNotice).toHaveBeenCalledWith({
      message: "Sent to Codex on cursor-foia.",
      action: { label: "Show", run: expect.any(Function) },
    });
    onNotice.mock.calls[0]?.[0].action.run();
    expect(onShowAgent).toHaveBeenCalledWith(foiaThreadId, "chat");

    // The agent picked there gets the next annotations in one click.
    await annotateOne(container, design);
    await vi.waitFor(() =>
      expect(send()?.dataset.tooltip).toBe("Send to Codex on cursor-foia. Shift+click to edit it first."),
    );
    await act(async () => {
      send()?.click();
    });
    expect(fake.dispatched).toHaveLength(2);
    expect(fake.dispatched.at(-1)?.command).toMatchObject({ type: "thread.queue", threadId: foiaThreadId });
  });

  it("groups the agents by worktree, keeps one click for the one here, and never lists other projects", async () => {
    const fake = createBridge(baseTab, [], [chatAgent, foiaAgent, strangerAgent], { worktrees });
    const design = withAnnotate(fake.bridge);
    const { container } = await renderPane(fake.bridge, false);
    await annotateOne(container, design);
    await vi.waitFor(() =>
      expect(buttonNamed(container, "Send 1 annotation")?.dataset.tooltip).toBe(
        "Send to Codex. Shift+click to edit it first.",
      ),
    );
    await act(async () => {
      buttonNamed(container, "Choose agent")?.click();
    });
    const menu = document.querySelector('[role="menu"]');
    const groups = [...(menu?.querySelectorAll('[role="group"]') ?? [])];
    expect(groups.map((group) => group.textContent)).toEqual(["main (this worktree)Codex", "cursor-foiaCodex"]);
    expect(groups.map((group) => group.querySelector('[role^="menuitem"]')?.getAttribute("aria-checked"))).toEqual([
      "true",
      "false",
    ]);
    await act(async () => {
      groups[1]?.querySelector<HTMLElement>('[role^="menuitem"]')?.click();
    });
    expect(fake.dispatched.at(-1)?.command).toMatchObject({ type: "thread.queue", threadId: foiaThreadId });
    expect(String(fake.dispatched.at(-1)?.command.text)).toContain("You work on cursor-foia");

    // The agent picked from the menu is the one the next click goes to.
    await annotateOne(container, design);
    await vi.waitFor(() =>
      expect(buttonNamed(container, "Send 1 annotation")?.dataset.tooltip).toContain("on cursor-foia"),
    );
  });

  it("pastes in a terminal agent elsewhere without moving the app there, and says the images stay behind", async () => {
    const terminalId = "00000000-0000-4000-8000-000000000501";
    const terminal = {
      terminalId,
      sessionId: "00000000-0000-4000-8000-000000000502",
      worktreeId: foia.worktreeId,
      kind: "agent",
      agent: { provider: "claude-code" },
      status: "running",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as unknown as TerminalProjection;
    const fake = createBridge(baseTab, [], [], { worktrees, terminals: [terminal] });
    const design = withAnnotate(fake.bridge);
    const onNotice = vi.fn();
    const onShowAgent = vi.fn();
    const { container } = await renderPane(fake.bridge, false, undefined, { onNotice, onShowAgent });
    await annotateOne(container, design);
    await act(async () => {
      buttonNamed(container, "Choose agent")?.click();
    });
    await act(async () => {
      document.querySelector<HTMLElement>('[role="menu"] [role="group"] [role^="menuitem"]')?.click();
    });
    expect(onShowAgent).not.toHaveBeenCalled();
    const command = fake.dispatched.at(-1)?.command;
    expect(command).toMatchObject({ type: "terminal.write", terminalId });
    expect(
      String(command?.data).startsWith("\x1b[200~This annotation was made in the browser of another worktree"),
    ).toBe(true);
    expect(onNotice).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Pasted in Claude Code on cursor-foia without the images. Press Enter there to send it.",
      }),
    );
    expect(container.querySelector('[aria-label="Annotations"]')).toBeNull();
  });

  it("keeps the annotations when the agent in another worktree does not take them", async () => {
    const fake = createBridge(baseTab, [], [foiaAgent], { worktrees, reject: "The chat has ended." });
    const design = withAnnotate(fake.bridge);
    const onNotice = vi.fn();
    const { container } = await renderPane(fake.bridge, false, undefined, { onNotice });
    await annotateOne(container, design);
    await act(async () => {
      buttonNamed(container, "Choose agent")?.click();
    });
    await act(async () => {
      document.querySelector<HTMLElement>('[role="menu"] [role="group"] [role^="menuitem"]')?.click();
    });
    const dialog = document.querySelector('[role="dialog"][aria-label="Send annotations"]');
    expect(dialog?.querySelector('[role="alert"]')?.textContent).toBe("The chat has ended.");
    expect(dialog?.querySelector<HTMLInputElement>('input[type="radio"]')?.checked).toBe(true);
    expect(container.querySelector('[aria-label="Annotations"]')?.textContent).toContain("1 annotation");
    expect(onNotice).not.toHaveBeenCalled();
  });
});
describe("BrowserPane without a worktree", () => {
  it("offers each project's folder and opens the one picked", async () => {
    const fake = createBridge(baseTab);
    const onOpenProject = vi.fn(async () => undefined);
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <RuntimeProvider bridge={fake.bridge}>
          <BrowserPane
            worktree={undefined}
            projects={[{ projectId: worktree.projectId, path: "C:/notes", name: "notes", git: false }]}
            onOpenProject={onOpenProject}
          />
        </RuntimeProvider>,
      );
    });
    expect(container.textContent).toContain("Open the browser in a project");
    const button = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "Open notes",
    );
    await act(async () => {
      button?.click();
    });
    expect(onOpenProject).toHaveBeenCalledWith(worktree.projectId);
  });

  it("asks for a worktree when there is no project to offer", async () => {
    const fake = createBridge(baseTab);
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <RuntimeProvider bridge={fake.bridge}>
          <BrowserPane worktree={undefined} projects={[]} onOpenProject={async () => undefined} />
        </RuntimeProvider>,
      );
    });
    expect(container.textContent).toContain("Select a worktree first");
  });
});

function withAnnotate(bridge: ZliBridge) {
  const waiting: Array<(value: unknown) => void> = [];
  const design = {
    designPick: vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          waiting.push(resolve);
        }),
    ),
    designInspect: vi.fn(async (input: unknown) => {
      const selector = (input as { selector: string }).selector;
      return selector === "#save"
        ? {
            tag: "button",
            name: "Save",
            url: baseTab.url,
            html: '<button id="save">Save</button>',
            styles: { color: "rgb(0, 0, 0)" },
            bounds: { x: 10, y: 20, width: 80, height: 30 },
            screenshot: { data: "aGVsbG8=", mimeType: "image/png" },
          }
        : selector === "h1"
          ? { tag: "h1", name: "Welcome", url: baseTab.url, styles: {} }
          : undefined;
    }),
    // Ending the session in the page resolves the pick waiting on it with null.
    designCancel: vi.fn(async () => {
      for (const resolve of waiting.splice(0)) resolve(null);
    }),
    designMark: vi.fn(async () => true),
    designCapture: vi.fn(async () => ({ data: "cmVnaW9u", mimeType: "image/png" })),
  };
  Object.assign(bridge.browser, design);
  return {
    ...design,
    /** Resolves the pick the pane is waiting on and lets it read the result and wait for the next one. */
    async answer(value: unknown) {
      await act(async () => {
        waiting.shift()?.(value);
        for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
      });
    },
  };
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function buttonNamed(container: ParentNode, name: string) {
  return [...container.querySelectorAll("button")].find(
    (button) => button.getAttribute("aria-label") === name || button.textContent === name,
  );
}
