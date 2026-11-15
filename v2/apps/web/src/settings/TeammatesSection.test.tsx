// @vitest-environment jsdom

import type { RuntimeProjection } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS, readAppSettings, updateAppSettings } from "./appSettings.js";
import { TeammatesSection } from "./TeammatesSection.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  updateAppSettings(() => DEFAULT_SETTINGS);
});

const projection = {
  providers: [{ provider: "codex", displayName: "Codex", status: "found", path: "codex" }],
} as unknown as RuntimeProjection;

function show(): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  act(() => {
    root = createRoot(host);
    root.render(<TeammatesSection projection={projection} />);
  });
  return host;
}

function button(host: HTMLElement, name: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find(
    (candidate) => candidate.getAttribute("aria-label") === name || candidate.textContent?.trim() === name,
  );
  if (!found) throw new Error(`No button named ${name}`);
  return found;
}

describe("TeammatesSection", () => {
  it("picks a color for a new teammate, with no body to choose", () => {
    updateAppSettings((settings) => ({
      ...settings,
      teammates: [{ id: "t1", name: "Tester", buddy: "sky", provider: "codex" }],
    }));
    const host = show();
    act(() => button(host, "Add teammate").click());

    expect(host.textContent).not.toContain("Buddy");
    const swatches = [...host.querySelectorAll<HTMLButtonElement>(".teammate-colors button")];
    expect(swatches.map((swatch) => swatch.getAttribute("aria-label"))).toEqual([
      "Sky",
      "Indigo",
      "Orchid",
      "Rose",
      "Tomato",
      "Tangerine",
      "Butter",
      "Lime",
      "Jade",
      "Clay",
      "Paper",
      "Slate",
    ]);
    // Sky is taken by Tester, so the new teammate starts as the next free color.
    expect(button(host, "Indigo").getAttribute("aria-pressed")).toBe("true");

    act(() => button(host, "Rose").click());
    expect(button(host, "Rose").getAttribute("aria-pressed")).toBe("true");
    expect(button(host, "Indigo").getAttribute("aria-pressed")).toBe("false");
    expect(host.querySelector<HTMLInputElement>("input.input")?.placeholder).toBe("Rose");
  });

  it("saves the color picked for a new teammate", () => {
    const host = show();
    act(() => button(host, "Add teammate").click());
    act(() => button(host, "Jade").click());
    const name = host.querySelector<HTMLInputElement>('input[maxlength="40"]');
    act(() => {
      if (!name) return;
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setValue?.call(name, "Reviewer");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => host.querySelector("form")?.requestSubmit());
    expect(readAppSettings().teammates.map((teammate) => [teammate.name, teammate.buddy])).toEqual([
      ["Reviewer", "jade"],
    ]);
  });
});
