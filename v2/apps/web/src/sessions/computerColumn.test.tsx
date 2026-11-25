// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { resetComputerColumnForTests, setComputerColumnShown, useComputerColumnShown } from "./computerColumn.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  window.localStorage.clear();
  resetComputerColumnForTests();
});

function Probe({ name }: { name: string }) {
  return <span data-name={name}>{useComputerColumnShown() ? "shown" : "hidden"}</span>;
}

describe("computer column", () => {
  it("shows by default, and closing it closes it in every chat and is remembered", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <>
          <Probe name="a" />
          <Probe name="b" />
        </>,
      ),
    );
    expect(container.textContent).toBe("shownshown");
    await act(async () => setComputerColumnShown(false));
    expect(container.textContent).toBe("hiddenhidden");
    expect(window.localStorage.getItem("zli.computerColumn.hidden")).toBe("1");
    await act(async () => resetComputerColumnForTests());
    expect(container.textContent).toBe("hiddenhidden");
    await act(async () => setComputerColumnShown(true));
    expect(window.localStorage.getItem("zli.computerColumn.hidden")).toBeNull();
    expect(container.textContent).toBe("shownshown");
  });
});
