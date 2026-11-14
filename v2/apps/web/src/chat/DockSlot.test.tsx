// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { DockSlot, type DockItem, firstDockItem } from "./DockSlot.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.replaceChildren();
});

describe("firstDockItem", () => {
  it("takes the first item present, so the most pressing wins", () => {
    const queue = { key: "queue", node: "Queued" };
    const error = { key: "error", node: "Failed" };
    expect(firstDockItem([false, undefined, "", queue, error])?.key).toBe("queue");
    expect(firstDockItem([null, error])?.key).toBe("error");
    expect(firstDockItem([false, ""])).toBeUndefined();
  });
});

describe("DockSlot", () => {
  it("shows one item at a time and stays empty without one", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const show = (item: DockItem | undefined) => act(() => root.render(<DockSlot item={item} />));

    show(undefined);
    const slot = host.querySelector(".chat-slot");
    expect(slot?.classList.contains("is-filled")).toBe(false);
    expect(host.querySelectorAll(".chat-slot-item")).toHaveLength(0);

    show({ key: "request", node: <p>Allow the command?</p> });
    expect(slot?.classList.contains("is-filled")).toBe(true);
    expect(host.querySelectorAll(".chat-slot-item")).toHaveLength(1);
    expect(host.textContent).toBe("Allow the command?");

    show({ key: "queue", node: <p>1 queued message</p> });
    expect(host.querySelectorAll(".chat-slot-item")).toHaveLength(1);
    expect(host.textContent).toBe("1 queued message");
    act(() => root.unmount());
  });
});
