// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import type { ContextUsage } from "../usage/usage.js";
import { ContextMeter } from "./ContextMeter.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.replaceChildren();
});

function render(context: ContextUsage) {
  const host = document.createElement("div");
  document.body.append(host);
  act(() => createRoot(host).render(<ContextMeter context={context} />));
  return host.querySelector<HTMLButtonElement>(".composer-context");
}

describe("ContextMeter", () => {
  it("fills the ring with the share of the window used and stays grey until nearly full", () => {
    const meter = render({ tokens: 100_000, window: 200_000 });
    expect(meter?.getAttribute("aria-label")).toBe("50% of context used, 100k of 200k tokens");
    expect(meter?.classList.contains("is-full")).toBe(false);
    const fill = meter?.querySelector(".context-ring-fill");
    const dash = Number(fill?.getAttribute("stroke-dasharray"));
    expect(Number(fill?.getAttribute("stroke-dashoffset"))).toBeCloseTo(dash / 2);
  });

  it("turns amber above 85%", () => {
    expect(render({ tokens: 170_000, window: 200_000 })?.classList.contains("is-full")).toBe(false);
    expect(render({ tokens: 180_000, window: 200_000 })?.classList.contains("is-full")).toBe(true);
  });

  it("shows the counts and the last turn's breakdown on hover", () => {
    const meter = render({ tokens: 180_000, window: 200_000, turn: { input: 12_000, cached: 9_000, output: 800 } });
    act(() => meter?.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));
    const popup = document.querySelector('[role="tooltip"].context-popup');
    expect(popup?.querySelector(".context-popup-percent")?.textContent).toBe("90%");
    expect(popup?.querySelector(".context-popup-tokens")?.textContent).toBe("180k / 200k tokens");
    expect([...(popup?.querySelectorAll(".context-popup-row") ?? [])].map((row) => row.textContent)).toEqual([
      "Input12k",
      "Cached9k · 75%",
      "Output800",
    ]);
    expect(popup?.querySelector(".context-popup-note")).toBeNull();
    expect(meter?.getAttribute("aria-describedby")).toBe(popup?.id);
    act(() => meter?.dispatchEvent(new MouseEvent("pointerout", { bubbles: true })));
    expect(document.querySelector(".context-popup")).toBeNull();
  });

  it("says when a turn mostly missed the prompt cache", () => {
    const meter = render({ tokens: 60_000, turn: { input: 60_000, cached: 6_000, output: 500, cacheMissed: true } });
    act(() => meter?.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));
    expect(document.querySelector(".context-popup-note")?.textContent).toBe(
      "Most of this turn was sent without the prompt cache, so it used more of your plan's limit.",
    );
  });

  it("shows the minutes left on the prompt cache, then that it expired", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const context: ContextUsage = { tokens: 9_000, cacheExpiresAt: 10_000_000 };
    const show = (now: number) => {
      act(() => createRoot(host).render(<ContextMeter context={context} now={() => now} />));
      act(() =>
        host.querySelector(".composer-context")?.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })),
      );
      const popup = document.querySelector(".context-popup");
      const text = popup?.querySelector(".context-popup-cache, .context-popup-note")?.textContent;
      act(() =>
        host.querySelector(".composer-context")?.dispatchEvent(new MouseEvent("pointerout", { bubbles: true })),
      );
      return text;
    };
    expect(show(10_000_000 - 38 * 60_000 - 5_000)).toBe("Prompt cache: 38 min left");
    expect(show(10_000_000 + 1)).toBe("Prompt cache expired. The next message rereads this thread at full price.");
  });

  it("shows the token count alone when the agent does not report its window", () => {
    const meter = render({ tokens: 4_200 });
    expect(meter?.getAttribute("aria-label")).toBe("4.2k tokens in context");
    expect(meter?.querySelector(".context-ring-fill")).toBeNull();
  });
});
