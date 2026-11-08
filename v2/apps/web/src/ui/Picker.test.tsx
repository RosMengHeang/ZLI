// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Picker, type PickerOption } from "./Picker.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

async function renderPicker(options: readonly PickerOption<string>[], onChange = vi.fn()) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <Picker label="Device" value={options[0]?.value ?? ""} options={options} onChange={onChange}>
        Pick
      </Picker>,
    );
  });
  const trigger = container.querySelector("button");
  if (!trigger) throw new Error("No trigger");
  await act(async () => trigger.click());
  return onChange;
}

function sections() {
  return [...document.querySelectorAll('[role="listbox"] > [role="group"]')].map((group) => {
    const labelId = group.getAttribute("aria-labelledby");
    return {
      label: labelId ? document.getElementById(labelId)?.textContent : undefined,
      options: [...group.querySelectorAll('[role="option"]')].map((option) => option.getAttribute("data-label")),
    };
  });
}

describe("Picker", () => {
  it("keeps a flat list when no option names a group", async () => {
    await renderPicker([
      { value: "a", label: "Alpha" },
      { value: "b", label: "Beta" },
    ]);
    expect(document.querySelectorAll('[role="group"]')).toHaveLength(0);
    expect([...document.querySelectorAll('[role="option"]')].map((option) => option.textContent)).toEqual([
      "Alpha",
      "Beta",
    ]);
  });

  it("groups options under labelled headings in first-seen order, with ungrouped options in their own section", async () => {
    const onChange = await renderPicker([
      { value: "a", label: "Alpha", group: "Letters" },
      { value: "1", label: "One", group: "Numbers" },
      { value: "b", label: "Beta", group: "Letters" },
      { value: "new", label: "New item" },
    ]);
    expect(sections()).toEqual([
      { label: "Letters", options: ["Alpha", "Beta"] },
      { label: "Numbers", options: ["One"] },
      { label: undefined, options: ["New item"] },
    ]);

    const listbox = document.querySelector<HTMLElement>('[role="listbox"]');
    if (!listbox) throw new Error("No listbox");
    await act(async () => {
      listbox.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    });
    expect(document.activeElement?.getAttribute("data-label")).toBe("New item");
    await act(async () => {
      listbox.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    });
    expect(document.activeElement?.getAttribute("data-label")).toBe("One");
    await act(async () => (document.activeElement as HTMLElement).click());
    expect(onChange).toHaveBeenCalledWith("1");
  });

  it("stays open while another part of the window scrolls, and closes when the trigger's own container scrolls", async () => {
    await renderPicker([{ value: "a", label: "Alpha" }]);
    const elsewhere = document.createElement("div");
    document.body.append(elsewhere);
    act(() => {
      elsewhere.dispatchEvent(new Event("scroll"));
    });
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();
    act(() => {
      document.body.firstElementChild?.dispatchEvent(new Event("scroll"));
    });
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });
});
