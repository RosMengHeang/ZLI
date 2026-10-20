// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Markdown } from "../chat/Markdown.js";
import type { FileLinks } from "./FileIndex.js";
import { findFileReferences, indexBasenames, parseFileReference } from "./filePaths.js";
import { parseQuickOpenQuery } from "./QuickOpen.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

function links(open: FileLinks["open"]): FileLinks {
  const files = new Set(["src/app.ts", "package.json"]);
  const basenames = indexBasenames(files);
  return {
    find: (text) => findFileReferences(text, "C:/repo", files, basenames),
    resolve: (text) => parseFileReference(text, "C:/repo", files, basenames),
    open,
    touch: () => undefined,
  };
}

describe("parseQuickOpenQuery", () => {
  it("splits off a line and column", () => {
    expect(parseQuickOpenQuery(" app.ts:42:7 ")).toEqual({ text: "app.ts", line: 42, column: 7 });
    expect(parseQuickOpenQuery("app.ts:42")).toEqual({ text: "app.ts", line: 42 });
    expect(parseQuickOpenQuery("app")).toEqual({ text: "app" });
  });
});

describe("Markdown file links", () => {
  it("turns paths in inline code, links, and plain text into buttons that open the file", async () => {
    const open = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <Markdown
          text={"Changed `src/app.ts:12` and [the manifest](package.json).\nAlso src/app.ts, not `other.ts`."}
          links={links(open)}
        />,
      );
    });
    const buttons = [...container.querySelectorAll<HTMLButtonElement>("button.md-file-link")];
    expect(buttons.map((button) => button.textContent)).toEqual(["src/app.ts:12", "the manifest", "src/app.ts"]);
    expect(container.querySelector("code:not(button code)")?.textContent).toBe("other.ts");
    act(() => buttons[0]?.click());
    expect(open).toHaveBeenCalledWith({ path: "src/app.ts", line: 12 });
    act(() => buttons[1]?.click());
    expect(open).toHaveBeenLastCalledWith({ path: "package.json" });
  });

  it("leaves text alone without links", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<Markdown text="See `src/app.ts`." />);
    });
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("code")?.textContent).toBe("src/app.ts");
  });
});
