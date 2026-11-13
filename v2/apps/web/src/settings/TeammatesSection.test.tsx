// @vitest-environment jsdom

import type { RuntimeProjection } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { readAppSettings, updateAppSettings } from "./appSettings.js";
import { TeammatesSection } from "./TeammatesSection.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const projection = {
  providers: [{ provider: "codex", displayName: "Codex", status: "found", path: "codex" }],
} as unknown as RuntimeProjection;

let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  updateAppSettings((current) => ({ ...current, teammates: [] }));
});

function button(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (element) => element.getAttribute("aria-label") === name || element.textContent?.trim() === name,
  );
  if (!found) throw new Error(`No button ${name}`);
  return found;
}

describe("TeammatesSection", () => {
  it("saves the body and color picked for a new teammate", () => {
    const host = document.createElement("div");
    document.body.append(host);
    act(() => {
      root = createRoot(host);
      root.render(<TeammatesSection projection={projection} />);
    });
    act(() => button("Add teammate").click());
    act(() => button("Cloud").click());
    act(() => button("Jade").click());
    expect(button("Cloud").getAttribute("aria-pressed")).toBe("true");
    expect(button("Jade").getAttribute("aria-pressed")).toBe("true");
    const name = document.querySelector<HTMLInputElement>('input[maxlength="40"]');
    expect(name?.placeholder).toBe("Cloud");
    act(() => {
      if (!name) return;
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setValue?.call(name, "Reviewer");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const form = document.querySelector("form");
    act(() => form?.requestSubmit());
    expect(readAppSettings().teammates.map((teammate) => [teammate.name, teammate.buddy])).toEqual([
      ["Reviewer", "cloud/jade"],
    ]);
  });
});
