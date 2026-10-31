// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StopButton } from "./StopButton.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => document.body.replaceChildren());

async function render(element: React.ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => createRoot(container).render(element));
  return container.querySelector("button") as HTMLButtonElement;
}

describe("StopButton", () => {
  it("is named by its label and stops on click", async () => {
    const onClick = vi.fn();
    const button = await render(<StopButton label="Stop Codex" tooltip="Stop the turn" onClick={onClick} />);
    expect(button.getAttribute("aria-label")).toBe("Stop Codex");
    expect(button.dataset.tooltip).toBe("Stop the turn");
    expect(button.classList.contains("is-icon")).toBe(true);
    await act(async () => button.click());
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("holds the ring still for an idle agent and blocks clicks while stopping", async () => {
    const idle = await render(
      <StopButton label="Stop agent" working={false}>
        Stop
      </StopButton>,
    );
    expect(idle.classList.contains("is-idle")).toBe(true);
    expect(idle.classList.contains("has-label")).toBe(true);
    const stopping = await render(<StopButton label="Cancel" stopping />);
    expect(stopping.getAttribute("aria-busy")).toBe("true");
    expect(stopping.disabled).toBe(true);
  });
});
