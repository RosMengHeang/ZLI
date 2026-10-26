// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ZliBridge } from "../runtime/bridge.js";
import { RuntimeProvider } from "../runtime/RuntimeProvider.js";
import { matchingSections, SettingsDialog } from "./SettingsDialog.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  window.localStorage.clear();
});

const bridge = {
  runtime: { getProjection: async () => undefined, onProjection: () => () => undefined },
} as unknown as ZliBridge;

async function render(onClose = vi.fn()) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <RuntimeProvider bridge={bridge}>
        <SettingsDialog
          projection={undefined}
          notifications={{ settings: undefined, update: () => undefined }}
          onClose={onClose}
        />
      </RuntimeProvider>,
    );
  });
  return container;
}

function tabs(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent ?? "");
}

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("matchingSections", () => {
  it("finds sections by label, group, and the words people use for them", () => {
    expect(matchingSections("").length).toBeGreaterThan(10);
    expect(matchingSections("emulator").map((entry) => entry.id)).toEqual(["mobile"]);
    expect(matchingSections("MCP").map((entry) => entry.id)).toEqual(["integrations"]);
    expect(matchingSections("workspace").map((entry) => entry.id)).toEqual(["projects", "worktrees", "files"]);
    expect(matchingSections("branch template").map((entry) => entry.id)).toEqual(["worktrees"]);
    expect(matchingSections("nothing like this")).toEqual([]);
  });
});

describe("SettingsDialog", () => {
  it("groups the sections, and names the open one in the breadcrumb", async () => {
    const container = await render();
    const headings = [...container.querySelectorAll(".settings-nav-heading")].map((node) => node.textContent);
    expect(headings).toEqual(["Agents", "Workspace", "Tools", "App"]);
    expect(tabs(container)).toContain("Mobile");
    expect(container.querySelector(".settings-crumbs")?.textContent).toBe("AgentsNew agents");
    const mobile = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
      (tab) => tab.textContent === "Mobile",
    );
    await act(async () => mobile?.click());
    expect(mobile?.getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector(".settings-crumbs")?.textContent).toBe("ToolsMobile");
  });

  it("filters the section list as you type, opens the first match on Enter, and clears on Escape", async () => {
    const onClose = vi.fn();
    const container = await render(onClose);
    const search = container.querySelector<HTMLInputElement>('input[aria-label="Search settings"]');
    if (!search) throw new Error("No search field");
    await act(async () => type(search, "android"));
    expect(tabs(container)).toEqual(["Mobile"]);
    await act(async () => {
      search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Mobile");

    await act(async () => type(search, "zzz"));
    expect(tabs(container)).toEqual([]);
    expect(container.querySelector(".settings-nav-empty")?.textContent).toBe("Nothing matches zzz.");

    const escapeKey = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    const reachedWindow = vi.fn();
    window.addEventListener("keydown", reachedWindow);
    await act(async () => {
      search.dispatchEvent(escapeKey);
    });
    window.removeEventListener("keydown", reachedWindow);
    expect(search.value).toBe("");
    // The shell closes Settings on Escape, so clearing the search must keep the key from reaching it.
    expect(reachedWindow).not.toHaveBeenCalled();
    expect(tabs(container).length).toBeGreaterThan(10);
  });
});
