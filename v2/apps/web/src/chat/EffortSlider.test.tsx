// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { EffortSlider } from "./EffortSlider.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.replaceChildren();
});

function render(value: string | undefined, picks: (string | undefined)[]) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      <EffortSlider
        noun="Effort"
        levels={["low", "medium", "high", "xhigh"]}
        defaultLevel="medium"
        value={value}
        modelLabel="Opus"
        tooltip="Effort"
        onChange={(level) => picks.push(level)}
      />,
    ),
  );
  const trigger = document.querySelector<HTMLButtonElement>('button[aria-label^="Effort:"]');
  act(() => trigger?.click());
  return document.querySelector<HTMLElement>('[role="slider"]');
}

describe("EffortSlider", () => {
  it("starts on the model's own level and steps along the track with the arrow keys", () => {
    const picks: (string | undefined)[] = [];
    const slider = render(undefined, picks);
    expect(slider?.getAttribute("aria-valuetext")).toBe("Medium");
    act(() => {
      slider?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    act(() => {
      slider?.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    });
    expect(picks).toEqual(["high", "low"]);
  });

  it("goes back to the model's own level from the reset button", () => {
    const picks: (string | undefined)[] = [];
    render("xhigh", picks);
    expect(document.querySelector('[role="slider"]')?.getAttribute("aria-valuenow")).toBe("3");
    act(() => document.querySelector<HTMLButtonElement>(".effort-reset")?.click());
    expect(picks).toEqual([undefined]);
  });
});
