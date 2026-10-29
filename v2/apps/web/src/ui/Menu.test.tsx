// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MenuButton, type MenuEntry } from "./Menu.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

async function render(items: readonly MenuEntry[]) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<MenuButton label="More" icon="more" items={items} />);
  });
  const trigger = container.querySelector("button");
  if (!trigger) throw new Error("No trigger");
  return trigger;
}

function key(target: Element, name: string) {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

const focused = () => document.activeElement?.textContent;

describe("MenuButton", () => {
  it("opens a labelled menu, moves with the arrow keys past disabled items, and runs the picked item", async () => {
    const first = vi.fn();
    const third = vi.fn();
    const trigger = await render([
      { id: "a", label: "First", run: first },
      "separator",
      { id: "b", label: "Second", disabled: true, run: vi.fn() },
      { id: "c", label: "Third", run: third },
    ]);
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    await act(async () => trigger.click());
    const menu = document.querySelector('[role="menu"]');
    expect(menu?.getAttribute("aria-label")).toBe("More");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelectorAll(".picker-menu hr")).toHaveLength(1);
    expect(focused()).toBe("First");

    key(document.activeElement as Element, "ArrowDown");
    expect(focused()).toBe("Third");
    key(document.activeElement as Element, "ArrowDown");
    expect(focused()).toBe("First");
    key(document.activeElement as Element, "End");
    expect(focused()).toBe("Third");
    key(document.activeElement as Element, "Home");
    expect(focused()).toBe("First");

    await act(async () => (document.querySelector('[aria-disabled="true"]') as HTMLElement).click());
    expect(document.querySelector('[role="menu"]')).not.toBeNull();

    await act(async () => (document.activeElement as HTMLElement).click());
    expect(first).toHaveBeenCalledTimes(1);
    expect(third).not.toHaveBeenCalled();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("shows an on and off item as a checkbox with a check while it is on, reachable with the arrow keys", async () => {
    const toggle = vi.fn();
    const trigger = await render([
      { id: "a", label: "First", run: vi.fn() },
      { id: "frame", label: "Show frame", checked: true, run: toggle },
      { id: "grid", label: "Show grid", checked: false, run: vi.fn() },
    ]);
    await act(async () => trigger.click());
    const items = [...document.querySelectorAll(".menu-item")];
    expect(items.map((item) => [item.getAttribute("role"), item.getAttribute("aria-checked")])).toEqual([
      ["menuitem", null],
      ["menuitemcheckbox", "true"],
      ["menuitemcheckbox", "false"],
    ]);
    expect(items.map((item) => Boolean(item.querySelector(".menu-item-check")))).toEqual([false, true, false]);
    key(document.activeElement as Element, "ArrowDown");
    expect(focused()).toBe("Show frame");
    await act(async () => (document.activeElement as HTMLElement).click());
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it("opens on the last item with ArrowUp and closes on Escape, Tab, or a click elsewhere", async () => {
    const trigger = await render([
      { id: "a", label: "First", run: vi.fn() },
      { id: "b", label: "Last", run: vi.fn() },
    ]);
    trigger.focus();
    key(trigger, "ArrowUp");
    expect(focused()).toBe("Last");
    expect(key(document.activeElement as Element, "Escape").defaultPrevented).toBe(true);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    key(trigger, "ArrowDown");
    expect(focused()).toBe("First");
    key(document.activeElement as Element, "Tab");
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    await act(async () => trigger.click());
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    act(() => {
      document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("stays open while another part of the window scrolls, and closes when the button's own container scrolls", async () => {
    const trigger = await render([{ id: "a", label: "First", run: vi.fn() }]);
    const elsewhere = document.createElement("div");
    document.body.append(elsewhere);
    await act(async () => trigger.click());
    act(() => {
      elsewhere.dispatchEvent(new Event("scroll"));
      (document.querySelector('[role="menu"]') as HTMLElement).dispatchEvent(new Event("scroll"));
    });
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    act(() => {
      trigger.parentElement?.dispatchEvent(new Event("scroll"));
    });
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
});
