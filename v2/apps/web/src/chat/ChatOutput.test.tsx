// @vitest-environment jsdom

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buttonByText, cleanupRuntimeRenders, renderWithRuntime } from "../review/testRuntime.js";
import { CodeBlock } from "./CodeBlock.js";
import { Markdown } from "./Markdown.js";
import { hiddenSizeLabel, OUTPUT_RENDER_LIMIT, StepOutput, trimOutput } from "./WorkLog.js";

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});

afterEach(async () => {
  await cleanupRuntimeRenders();
  vi.restoreAllMocks();
});

const click = (element: Element | undefined) =>
  act(async () => {
    (element as HTMLElement).click();
  });

describe("reply links", () => {
  it("opens a web link in the browser and shows where it goes", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    await renderWithRuntime(<Markdown text="See [the docs](https://example.com/guide) first." />);
    const link = document.querySelector<HTMLButtonElement>("button.md-link");
    expect(link?.textContent).toBe("the docs");
    expect(link?.title).toBe("Open https://example.com/guide in your browser");
    await click(link ?? undefined);
    expect(open).toHaveBeenCalledWith("https://example.com/guide", "_blank", "noopener,noreferrer");
  });

  it("turns a bare address into a link", async () => {
    await renderWithRuntime(<Markdown text="Built at https://example.com/run/42 today" />);
    expect(document.querySelector("button.md-link")?.textContent).toBe("https://example.com/run/42");
  });

  it("leaves a link that is not a web address as plain text", async () => {
    await renderWithRuntime(<Markdown text="[run me](javascript:alert(1))" />);
    expect(document.querySelector("button.md-link")).toBeNull();
    expect(document.querySelector(".md-link.is-inert")?.textContent).toBe("run me");
  });
});

describe("code block copy", () => {
  it("copies every line of a long block, even while it is folded", async () => {
    const text = Array.from({ length: 3000 }, (_, index) => `const line${index} = ${"x".repeat(80)};`).join("\n");
    await renderWithRuntime(<CodeBlock lang="ts" text={text} />);
    expect(document.querySelector(".md-code-block.is-folded")).not.toBeNull();
    expect(buttonByText("Show all 3000 lines")).toBeDefined();
    await click(buttonByText("Copy"));
    expect(writeText).toHaveBeenCalledWith(text);
  });
});

describe("tool output", () => {
  it("leaves output under the limit whole", () => {
    expect(trimOutput("a".repeat(OUTPUT_RENDER_LIMIT))).toBeUndefined();
  });

  it("keeps the ends of output over the limit", () => {
    const text = `${"a".repeat(100_000)}${"b".repeat(300_000)}${"c".repeat(100_000)}`;
    const trim = trimOutput(text);
    expect(trim?.head).toBe("a".repeat(60_000));
    expect(trim?.tail).toBe("c".repeat(20_000));
    expect(trim && trim.head.length + trim.hidden + trim.tail.length).toBe(text.length);
    expect(hiddenSizeLabel(420_000)).toBe("410 KB");
  });

  it("folds long output to its ends until asked for all of it", async () => {
    const text = Array.from({ length: 50 }, (_, index) => `line ${index + 1}`).join("\n");
    await renderWithRuntime(<StepOutput text={text} />);
    expect(document.querySelector(".step-detail")?.textContent).not.toContain("line 25");
    await click(buttonByText("… +44 lines"));
    expect(document.querySelector(".step-detail")?.textContent).toContain("line 25");
  });

  it("renders only the ends of huge output and copies all of it", async () => {
    const text = Array.from({ length: 20_000 }, (_, index) => `row ${index} ${"y".repeat(40)}`).join("\n");
    await renderWithRuntime(<StepOutput text={text} />);
    await click(buttonByText("… +19994 lines"));
    const shown = document.querySelector(".step-detail")?.textContent ?? "";
    expect(shown.length).toBeLessThan(100_000);
    expect(shown).toContain("row 0 ");
    expect(shown).toContain("row 19999 ");
    expect(document.querySelector(".step-trimmed")?.textContent).toMatch(/^Output trimmed, [\d,]+ KB hidden\./u);
    await click(buttonByText("Copy all"));
    expect(writeText).toHaveBeenCalledWith(text);
  });
});
