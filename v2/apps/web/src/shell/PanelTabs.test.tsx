// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LauncherItem } from "./launcherItems.js";
import { PanelTabs } from "./PanelTabs.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

async function render(node: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(node));
  return container;
}

describe("PanelTabs", () => {
  it("shows only the opened panels as tabs, closes them, and adds the rest from the plus", async () => {
    const select = vi.fn();
    const close = vi.fn();
    const openFiles = vi.fn();
    const items = [
      { id: "review", label: "Changes", detail: "", icon: "diff", count: 3, run: vi.fn() },
      { id: "files", label: "Files", detail: "", icon: "folderTree", run: openFiles },
    ] as LauncherItem[];
    const container = await render(
      <PanelTabs
        tabs={[
          { id: "review", label: "Changes", icon: "diff" },
          { id: "pullRequest", label: "Pull request", icon: "pullRequest" },
        ]}
        active="review"
        items={items}
        shortcutFor={(id) => (id === "pullRequest" ? "Ctrl+Shift+P" : undefined)}
        onSelect={select}
        onClose={close}
      />,
    );
    const tabs = [...container.querySelectorAll<HTMLButtonElement>('.panel-strip [role="tab"]')];
    expect(tabs.map((tab) => tab.getAttribute("aria-label"))).toEqual(["Changes", "Pull request"]);
    expect(container.querySelector(".panel-strip")?.getAttribute("aria-orientation")).toBe("horizontal");
    expect(tabs[0]?.textContent).toBe("Changes");
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs[1]?.dataset.shortcut).toBe("Ctrl+Shift+P");
    await act(async () => tabs[1]?.click());
    expect(select).toHaveBeenCalledWith("pullRequest");
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close Changes"]')?.click());
    expect(close).toHaveBeenCalledWith("review");

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Add a panel"]')?.click());
    const menu = container.querySelector('[role="menu"]');
    expect([...(menu?.querySelectorAll(".menu-item-label") ?? [])].map((label) => label.textContent)).toEqual([
      "Changes",
      "Files",
    ]);
    await act(async () => {
      menu?.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true }));
    });
    expect(openFiles).toHaveBeenCalled();
  });
});
