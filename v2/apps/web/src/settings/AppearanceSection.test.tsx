// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { type CustomTheme, MAX_CUSTOM_THEMES } from "../theme/customThemes.js";
import { closeThemeEditor, readThemeEditor, THEME_LIMIT_MESSAGE } from "../theme/themeEditorStore.js";
import { AppearanceSection } from "./AppearanceSection.js";
import { updateAppSettings } from "./appSettings.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const theme = (index: number): CustomTheme => ({
  id: `custom-mine${index.toString().padStart(2, "0")}`,
  name: `Mine ${index}`,
  basedOn: "midnight",
  seed: { background: "#000000", terminal: "#000000", accent: "#4a6fdc" },
  overrides: {},
});

let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  closeThemeEditor();
  document.body.replaceChildren();
  updateAppSettings((current) => ({ ...current, theme: "midnight", customThemes: [] }));
});

async function render(count: number) {
  updateAppSettings((current) => ({ ...current, customThemes: Array.from({ length: count }, (_, i) => theme(i)) }));
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(<AppearanceSection />));
}

async function openMenuOf(name: string): Promise<HTMLElement> {
  const button = document.querySelector<HTMLElement>(`[aria-label="${name} options"]`);
  if (!button) throw new Error(`No menu for ${name}`);
  await act(async () => button.click());
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((entry) =>
    entry.textContent?.includes("Duplicate"),
  );
  if (!item) throw new Error("No Duplicate item");
  return item;
}

describe("Appearance", () => {
  it("turns off Duplicate, like Create, when there is no room for another theme", async () => {
    await render(MAX_CUSTOM_THEMES);
    const duplicate = await openMenuOf("Mine 0");
    expect(duplicate.getAttribute("aria-disabled")).toBe("true");
    expect(duplicate.getAttribute("title")).toBe(THEME_LIMIT_MESSAGE);
    await act(async () => duplicate.click());
    expect(readThemeEditor()).toBeUndefined();
  });

  it("duplicates a theme while there is room", async () => {
    await render(1);
    const duplicate = await openMenuOf("Mine 0");
    expect(duplicate.getAttribute("aria-disabled")).toBeNull();
    await act(async () => duplicate.click());
    expect(readThemeEditor()?.draft.name).toBe("Mine 0 copy");
  });
});
