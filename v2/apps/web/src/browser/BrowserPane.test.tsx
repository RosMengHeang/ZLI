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
import { type BrowserReveal, BrowserPane } from "./BrowserPane.js";

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

  it("hides Pick element without the desktop design mode bridge", async () => {
    const fake = createBridge(baseTab);
    const { container } = await renderPane(fake.bridge, false);
    expect(container.querySelector('button[aria-label="Device size"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Pick element"]')).toBeNull();
  });

  it("picks an element, collects the request, and opens the send dialog over a hidden page", async () => {
    const fake = createBridge(baseTab);
    let finishPick: ((value: unknown) => void) | undefined;
    const designPick = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          finishPick = resolve;
        }),
    );
    const designInspect = vi.fn(async () => ({
      tag: "button",
      name: "Save",
      url: baseTab.url,
      html: '<button id="save">Save</button>',
      styles: { color: "rgb(0, 0, 0)" },
      bounds: { x: 10, y: 20, width: 80, height: 30 },
      screenshot: { data: "aGVsbG8=", mimeType: "image/png" },
    }));
    Object.assign(fake.bridge.browser, { designPick, designInspect, designCancel: vi.fn(async () => undefined) });
    const { container } = await renderPane(fake.bridge, false);
    const pickButton = container.querySelector<HTMLButtonElement>('button[aria-label="Pick element"]');
    await act(async () => {
      pickButton?.click();
    });
    expect(designPick).toHaveBeenCalledWith(baseTab.browserTabId);
    expect(pickButton?.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector(".browser-design-hint")?.textContent).toContain("Esc cancels");

    await act(async () => {
      finishPick?.({ selector: "#save" });
    });
    expect(designInspect).toHaveBeenCalledWith({ browserTabId: baseTab.browserTabId, selector: "#save" });
    expect(pickButton?.getAttribute("aria-pressed")).toBe("false");
    const panel = container.querySelector('[aria-label="Picked elements"]');
    expect(panel?.textContent).toContain("1 element picked");
    expect(panel?.textContent).toContain('<button> "Save"');
    expect(panel?.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,aGVsbG8=");

    const send = [...(panel?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent === "Send to agent",
    );
    expect(send?.disabled).toBe(true);
    const note = panel?.querySelector<HTMLTextAreaElement>('textarea[aria-label="What should change?"]');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(note, "Make it green.");
      note?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    fake.calls.length = 0;
    await act(async () => {
      send?.click();
    });
    expect(fake.calls).toContain("hide");
    const dialog = document.querySelector('[role="dialog"][aria-label="Send picked elements"]');
    const preview = dialog?.querySelector(".send-preview")?.textContent ?? "";
    expect(preview).toContain("What should change:\nMake it green.");
    expect(preview).toContain("Selector: `#save`");
  });

  it("cancels a pick with Escape", async () => {
    const fake = createBridge(baseTab);
    const designCancel = vi.fn(async () => undefined);
    Object.assign(fake.bridge.browser, { designPick: vi.fn(() => new Promise(() => undefined)), designCancel });
    const { container } = await renderPane(fake.bridge, false);
    const pickButton = container.querySelector<HTMLButtonElement>('button[aria-label="Pick element"]');
    await act(async () => {
      pickButton?.click();
    });
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(designCancel).toHaveBeenCalledWith(baseTab.browserTabId);
    expect(pickButton?.getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector(".browser-design-hint")).toBeNull();
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
