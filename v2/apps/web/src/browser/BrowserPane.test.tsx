// @vitest-environment jsdom

import {
  BrowserProfileId,
  BrowserTabId,
  type BrowserTabProjection,
  CommandId,
  EnvironmentId,
  ProjectId,
  type RuntimeProjection,
  WorktreeId,
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

function projectionWith(tab: BrowserTabProjection, extra: BrowserTabProjection[] = []): RuntimeProjection {
  return {
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
    browserTabs: [tab, ...extra],
    attention: [],
    lastSequence: 1,
  };
}

function createBridge(initial: BrowserTabProjection, extra: BrowserTabProjection[] = []) {
  let current = initial;
  let projectionListener: ((projection: RuntimeProjection) => void) | undefined;
  const calls: string[] = [];
  const bridge: ZliBridge = {
    runtime: {
      dispatch: async () => ({ commandId: CommandId.parse("00000000-0000-4000-8000-000000000099"), accepted: true }),
      getProjection: async () => projectionWith(current, extra),
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
    publish(next: BrowserTabProjection) {
      current = next;
      projectionListener?.(projectionWith(next, extra));
    },
  };
}

let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

async function renderPane(bridge: ZliBridge, obscured: boolean, reveal?: BrowserReveal) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <RuntimeProvider bridge={bridge}>
        <BrowserPane worktree={worktree} obscured={obscured} reveal={reveal} />
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

  it("keeps Annotate on across picks, gives each element its own instruction, and sends them in one message", async () => {
    const fake = createBridge(baseTab);
    const design = withAnnotate(fake.bridge);
    const { container } = await renderPane(fake.bridge, false);
    const annotate = container.querySelector<HTMLButtonElement>('button[aria-label="Annotate"]');
    await act(async () => {
      annotate?.click();
    });
    expect(design.designPick).toHaveBeenCalledWith(baseTab.browserTabId);
    expect(annotate?.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector(".browser-annotate-hint")?.textContent).toContain(
      "drag to mark a region. Esc exits.",
    );

    await design.answer({ kind: "element", selector: "#save" });
    expect(design.designInspect).toHaveBeenCalledWith({ browserTabId: baseTab.browserTabId, selector: "#save" });
    expect(design.designPick).toHaveBeenCalledTimes(2);
    expect(annotate?.getAttribute("aria-pressed")).toBe("true");
    await design.answer({ kind: "element", selector: "h1" });
    const panel = container.querySelector('[aria-label="Annotations"]');
    expect(panel?.textContent).toContain("2 annotations");
    expect(panel?.textContent).toContain('<button> "Save"');
    expect(panel?.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,aGVsbG8=");
    expect(design.designMark).toHaveBeenLastCalledWith({
      browserTabId: baseTab.browserTabId,
      marks: [
        { kind: "element", id: expect.any(String), n: 1, selector: "#save" },
        { kind: "element", id: expect.any(String), n: 2, selector: "h1" },
      ],
    });

    const send = container.querySelector<HTMLButtonElement>('button[aria-label="Send 2 annotations"]');
    expect(send?.textContent).toBe("2Send");
    expect(send?.disabled).toBe(true);
    await type(panel?.querySelector('textarea[aria-label="Instruction for annotation 1"]'), "Make it green.");
    await type(panel?.querySelector('textarea[aria-label="Instruction for annotation 2"]'), "Bigger, tighter.");
    expect(send?.disabled).toBe(false);
    fake.calls.length = 0;
    await act(async () => {
      send?.click();
    });
    expect(fake.calls).toContain("hide");
    const dialog = document.querySelector('[role="dialog"][aria-label="Send annotations"]');
    const preview = dialog?.querySelector(".send-preview")?.textContent ?? "";
    expect(preview).toContain("Please apply these 2 design annotations I made in the ZLI browser panel");
    expect(preview).toContain('### Annotation 1: <button> "Save"\nSelector: `#save`\nInstruction: Make it green.');
    expect(preview).toContain("### Annotation 2: <h1>");
    expect(preview).toContain("Instruction: Bigger, tighter.");
  });

  it("adds a drawn region with its sketch to the message", async () => {
    const fake = createBridge(baseTab);
    const design = withAnnotate(fake.bridge);
    const { container } = await renderPane(fake.bridge, false);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Annotate"]')?.click();
    });
    const region = {
      kind: "region",
      id: "region-1",
      bounds: { x: 40, y: 60, width: 300, height: 120 },
      viewport: { width: 1280, height: 720 },
      strokes: [{ tool: "pen", points: [50, 70, 60, 80] }],
    };
    await design.answer(region);
    expect(design.designCapture).toHaveBeenCalledWith({
      browserTabId: baseTab.browserTabId,
      bounds: region.bounds,
      strokes: region.strokes,
    });
    const panel = container.querySelector('[aria-label="Annotations"]');
    expect(panel?.textContent).toContain("Region");
    expect(panel?.textContent).toContain("1 mark drawn");
    expect(panel?.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,cmVnaW9u");
    expect(design.designMark).toHaveBeenLastCalledWith({
      browserTabId: baseTab.browserTabId,
      marks: [{ kind: "region", id: "region-1", n: 1, bounds: region.bounds, strokes: region.strokes }],
    });
    await type(panel?.querySelector('textarea[aria-label="Instruction for annotation 1"]'), "Add a signup card here");
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Send 1 annotation"]')?.click();
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
    const annotate = container.querySelector<HTMLButtonElement>('button[aria-label="Annotate"]');
    await act(async () => {
      annotate?.click();
    });
    await design.answer({ kind: "element", selector: "#save" });
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(design.designCancel).toHaveBeenCalledWith(baseTab.browserTabId);
    expect(annotate?.getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector(".browser-annotate-hint")?.textContent).toContain(
      "Annotate is off. Your annotations stay here until you send or clear them.",
    );
    expect(container.querySelector('[aria-label="Annotations"]')?.textContent).toContain("1 annotation");

    // Escape in the page ends the session the same way.
    const resume = [...container.querySelectorAll("button")].find((button) => button.textContent === "Resume");
    await act(async () => {
      resume?.click();
    });
    expect(annotate?.getAttribute("aria-pressed")).toBe("true");
    design.designCancel.mockClear();
    await design.answer(null);
    expect(annotate?.getAttribute("aria-pressed")).toBe("false");
    expect(design.designCancel).toHaveBeenCalledWith(baseTab.browserTabId);

    const clear = [...container.querySelectorAll("button")].find((button) => button.textContent === "Clear all");
    await act(async () => {
      clear?.click();
    });
    expect(container.querySelector('[aria-label="Annotations"]')).toBeNull();
    expect(container.querySelector(".browser-annotate-bar")).toBeNull();
  });

  it("previews text and CSS edits on the page and sends them as changes to make in code", async () => {
    const fake = createBridge(baseTab);
    const design = withAnnotate(fake.bridge);
    const { container } = await renderPane(fake.bridge, false);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Annotate"]')?.click();
    });
    await design.answer({ kind: "element", selector: "#save" });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Edit text and CSS of annotation 1"]')?.click();
    });
    const editor = container.querySelector(".browser-design-editor");
    const inputs = editor?.querySelectorAll<HTMLInputElement>("input") ?? [];
    await type(inputs[0], "Save all");
    expect(design.designPreview).toHaveBeenLastCalledWith({
      browserTabId: baseTab.browserTabId,
      selector: "#save",
      preview: { text: "Save all", styles: {} },
    });
    await type(inputs[1], "green");
    expect(editor?.textContent).toContain("was rgb(0, 0, 255)");
    const add = [...(editor?.querySelectorAll("button") ?? [])].find((button) => button.textContent === "Add 2 edits");
    await act(async () => {
      add?.click();
    });
    expect(container.querySelector(".browser-design-editor")).toBeNull();
    expect(container.querySelector(".browser-design-edits")?.textContent).toBe("1 CSS edit · text");
    const send = container.querySelector<HTMLButtonElement>('button[aria-label="Send 1 annotation"]');
    expect(send?.disabled).toBe(false);
    await act(async () => {
      send?.click();
    });
    const preview = document.querySelector('[aria-label="Send annotations"] .send-preview')?.textContent ?? "";
    expect(preview).toContain('Text: "Save" → "Save all"');
    expect(preview).toContain("CSS: background-color: rgb(0, 0, 255) → green");
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
            editable: {
              text: "Save",
              styles: {
                "background-color": "rgb(0, 0, 255)",
                color: "rgb(0, 0, 0)",
                padding: "8px",
                "font-size": "14px",
                "border-radius": "4px",
              },
            },
          }
        : { tag: "h1", name: "Welcome", url: baseTab.url, styles: {} };
    }),
    // Ending the session in the page resolves the pick waiting on it with null.
    designCancel: vi.fn(async () => {
      for (const resolve of waiting.splice(0)) resolve(null);
    }),
    designMark: vi.fn(async () => true),
    designCapture: vi.fn(async () => ({ data: "cmVnaW9u", mimeType: "image/png" })),
    designPreview: vi.fn(async () => true),
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

async function type(field: HTMLInputElement | HTMLTextAreaElement | null | undefined, value: string) {
  if (!field) throw new Error("The field is missing.");
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
