// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CapturePicker } from "./CapturePicker.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

describe("CapturePicker", () => {
  it("drops a window that closed since the list was read, and says so plainly", async () => {
    const capture = {
      sources: vi.fn(async () => [
        { id: "window:1", name: "Old window", kind: "window", thumbnail: "" },
        { id: "screen:0", name: "Entire screen", kind: "screen", thumbnail: "" },
      ]),
      take: vi.fn(async () => {
        throw new Error("Error invoking remote method 'zli:capture:take': Error: That window is closed or hidden.");
      }),
    };
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<CapturePicker capture={capture as never} onPick={() => undefined} onClose={() => undefined} />);
    });
    const first = container.querySelector<HTMLButtonElement>(".capture-source");
    await act(async () => first?.click());
    expect(container.textContent).toContain("That window is closed or hidden.");
    expect(container.textContent).not.toContain("remote method");
    expect([...container.querySelectorAll(".capture-source")].map((item) => item.textContent)).toEqual([
      expect.stringContaining("Entire screen"),
    ]);
  });
});
