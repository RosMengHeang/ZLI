// @vitest-environment jsdom

import type { ThreadActivityProjection } from "@zli-v2/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeProvider } from "../runtime/RuntimeProvider.js";
import { Markdown } from "./Markdown.js";
import { CitationContext, citationsFor, hostOf, SourcesRow, sourceKey, turnSources } from "./Sources.js";
import { WorkSteps } from "./WorkLog.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.replaceChildren();
});

const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, 0) + seconds * 1_000).toISOString();

const step = (extra: Partial<ThreadActivityProjection>) =>
  ({
    activityId: "a1",
    threadId: "00000000-0000-4000-8000-000000000001",
    turnId: "t1",
    kind: "command",
    title: "Run tests",
    status: "completed",
    ...extra,
  }) as ThreadActivityProjection;

function mount(node: ReactNode): { host: HTMLDivElement; root: Root } {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<RuntimeProvider bridge={undefined}>{node}</RuntimeProvider>));
  return { host, root };
}

const thinking = (extra: Partial<ThreadActivityProjection> = {}) =>
  step({ activityId: "k1", kind: "reasoning", title: "Thinking", ...extra });

describe("thinking", () => {
  it("streams open under a shimmering label, then folds to how long it took", () => {
    const { host, root } = mount(
      <WorkSteps activities={[thinking({ status: "running", text: "Reading the routes", startedAt: at(0) })]} />,
    );
    const label = host.querySelector(".thought-label");
    expect(label?.textContent).toBe("Thinking…");
    expect(label?.classList.contains("shimmer-text")).toBe(true);
    expect(host.querySelector(".thought-body")?.textContent).toContain("Reading the routes");
    expect(host.querySelector("button.thought-row")).toBeNull();

    act(() =>
      root.render(
        <RuntimeProvider bridge={undefined}>
          <WorkSteps
            activities={[
              thinking({ status: "completed", text: "Reading the routes", startedAt: at(0), completedAt: at(12) }),
            ]}
          />
        </RuntimeProvider>,
      ),
    );
    const row = host.querySelector<HTMLButtonElement>("button.thought-row");
    expect(row?.textContent).toBe("Thought for 12s");
    expect(row?.getAttribute("aria-expanded")).toBe("false");
    act(() => row?.click());
    expect(row?.getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelector(".thought-body")?.textContent).toContain("Reading the routes");
  });

  it("is only its label when it has no text, and marks text that was cut short", () => {
    const empty = mount(<WorkSteps activities={[thinking({ text: "" })]} />).host;
    expect(empty.querySelector(".thought-row")?.textContent).toBe("Thought for a few seconds");
    expect(empty.querySelector("button.thought-row")).toBeNull();
    expect(empty.querySelector(".thought-chevron")).toBeNull();

    const cut = mount(<WorkSteps activities={[thinking({ status: "running", text: "Long", truncated: true })]} />).host;
    expect(cut.querySelector(".thought-cut")?.textContent).toBe("…");
  });
});

describe("tool cards", () => {
  it("shows a finished step's time at the end of its row, and none under a second", () => {
    const { host } = mount(
      <WorkSteps
        activities={[
          step({ activityId: "c1", startedAt: at(0), completedAt: at(65) }),
          step({
            activityId: "c2",
            title: "Lint",
            startedAt: at(0),
            completedAt: new Date(Date.UTC(2026, 0, 1, 12, 0, 0, 400)).toISOString(),
          }),
        ]}
      />,
    );
    expect([...host.querySelectorAll(".step-time")].map((node) => node.textContent)).toEqual(["1m 05s"]);
  });

  it("opens to the call's arguments, holding long values to three lines until asked", () => {
    const long = Array.from({ length: 6 }, (_, index) => `line ${index}`).join("\n");
    const { host } = mount(
      <WorkSteps
        activities={[
          step({
            kind: "tool",
            title: "context7: get library docs",
            input: [
              { key: "libraryId", value: "/vercel/next.js" },
              { key: "filter", value: long },
            ],
            detail: "Docs",
          }),
        ]}
      />,
    );
    act(() => host.querySelector<HTMLButtonElement>(".step-row")?.click());
    expect([...host.querySelectorAll(".step-input dt")].map((node) => node.textContent)).toEqual([
      "libraryId",
      "filter",
    ]);
    const values = [...host.querySelectorAll(".step-input-value")];
    expect(values[0]?.classList.contains("is-clamped")).toBe(false);
    expect(values[1]?.classList.contains("is-clamped")).toBe(true);
    act(() => values[1]?.querySelector<HTMLButtonElement>(".step-more")?.click());
    expect(values[1]?.classList.contains("is-clamped")).toBe(false);
    expect(host.querySelector(".step-detail")?.textContent).toBe("Docs");
  });

  it("says Running inside a running call with no output yet, and Denied for a refused one", () => {
    const { host } = mount(
      <WorkSteps
        activities={[
          step({ activityId: "t1", kind: "tool", status: "running", input: [{ key: "q", value: "x" }] }),
          step({ activityId: "t2", kind: "tool", status: "failed", detail: "Rejected by user" }),
        ]}
      />,
    );
    act(() => host.querySelector<HTMLButtonElement>(".step-row")?.click());
    expect(host.querySelector(".step-pending")?.textContent).toBe("Running");
    expect(host.querySelector(".step-denied")?.textContent).toBe("Denied");
    expect(host.querySelector(".step-failed")).toBeNull();
  });

  it("puts a web step's pages under it as site chips", () => {
    const { host } = mount(
      <WorkSteps
        activities={[
          step({
            kind: "web",
            title: "Search the web",
            urls: [{ url: "https://www.nextjs.org/docs", title: "Docs" }, { url: "https://github.com/vercel/next.js" }],
          }),
        ]}
      />,
    );
    expect([...host.querySelectorAll(".source-chip-host")].map((node) => node.textContent)).toEqual([
      "nextjs.org",
      "github.com",
    ]);
  });
});

describe("sources", () => {
  const web = (urls: ThreadActivityProjection["urls"]) => step({ kind: "web", urls });

  it("collects a turn's pages once each, in the order they came up", () => {
    const sources = turnSources([
      web([{ url: "https://a.dev/x" }, { url: "https://b.dev/" }]),
      step({ kind: "command" }),
      web([{ url: "https://a.dev/x#part" }, { url: "https://c.dev" }]),
    ]);
    expect(sources.map((source) => source.url)).toEqual(["https://a.dev/x", "https://b.dev/", "https://c.dev"]);
    expect(hostOf("https://www.example.com/a")).toBe("example.com");
    expect(sourceKey("https://b.dev/")).toBe(sourceKey("https://b.dev"));
  });

  it("lists them under the reply, numbered, on request", () => {
    const { host } = mount(
      <SourcesRow sources={[{ url: "https://nextjs.org/docs", title: "Docs" }, { url: "https://github.com/x" }]} />,
    );
    const toggle = host.querySelector<HTMLButtonElement>(".sources-toggle");
    expect(toggle?.textContent).toBe("Sources (2)");
    act(() => toggle?.click());
    expect([...host.querySelectorAll(".sources-item")].map((node) => node.textContent)).toEqual([
      "1Docsnextjs.org",
      "2github.com",
    ]);
  });

  it("turns a reply's link to a source into a numbered citation that names the page on hover", () => {
    const citations = citationsFor([
      { url: "https://github.com/x" },
      { url: "https://nextjs.org/docs/revalidate", title: "revalidateTag" },
    ]);
    const { host } = mount(
      <CitationContext.Provider value={citations}>
        <Markdown text="It [only clears tagged fetches](https://nextjs.org/docs/revalidate/) and [other](https://else.dev)." />
      </CitationContext.Provider>,
    );
    const cite = host.querySelector<HTMLButtonElement>(".md-cite");
    expect(cite?.textContent).toBe("2");
    expect(host.querySelector(".markdown")?.textContent).toContain("only clears tagged fetches2");
    expect(host.querySelectorAll(".md-link")).toHaveLength(1);
    act(() => cite?.focus());
    expect(document.querySelector(".cite-card-title")?.textContent).toBe("revalidateTag");
    expect(document.querySelector(".cite-card-host")?.textContent).toBe("nextjs.org");
  });
});
