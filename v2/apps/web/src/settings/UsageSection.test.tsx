// @vitest-environment jsdom

import type { UsageReport } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ZliBridge } from "../runtime/bridge.js";
import { RuntimeProvider } from "../runtime/RuntimeProvider.js";
import { chartBars, formatUsd, shortDate } from "../usage/usageReport.js";
import { UsageSection } from "./UsageSection.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

const tokens = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
  input,
  output,
  cacheRead,
  cacheWrite,
  reasoning: 0,
});

function report(overrides: Partial<UsageReport> = {}): UsageReport {
  return {
    range: "30d",
    timeZone: "UTC",
    from: "2026-11-20",
    to: "2026-11-21",
    days: [
      { date: "2026-11-20", tokens: 0, costUsd: 0, providers: [] },
      {
        date: "2026-11-21",
        tokens: 2_101_000,
        costUsd: 4.5,
        providers: [
          { provider: "claude-code", tokens: 1_100_000, costUsd: 4.5 },
          { provider: "codex", tokens: 1_001_000, costUsd: 0 },
        ],
      },
    ],
    providers: [
      { provider: "claude-code", tokens: tokens(100_000, 0, 1_000_000), costUsd: 4.5, unpricedTokens: 0, requests: 12 },
      { provider: "codex", tokens: tokens(1_000_000, 1_000), costUsd: 0, unpricedTokens: 1_001_000, requests: 3 },
    ],
    models: [
      {
        provider: "claude-code",
        model: "claude-opus-5-5",
        tokens: tokens(100_000, 0, 1_000_000),
        costUsd: 4.5,
        unpricedTokens: 0,
        requests: 12,
        priced: true,
      },
      {
        provider: "codex",
        model: "gpt-9-mystery",
        tokens: tokens(1_000_000, 1_000),
        costUsd: 0,
        unpricedTokens: 1_001_000,
        requests: 3,
        priced: false,
      },
    ],
    totals: { tokens: tokens(1_100_000, 1_000, 1_000_000), costUsd: 4.5, unpricedTokens: 1_001_000, requests: 15 },
    files: 4,
    generatedAt: "2026-11-21T12:00:00.000Z",
    ...overrides,
  };
}

type Reply = { accepted: true; result: unknown } | { accepted: false; error: { code: string; message: string } };

async function render(reply: (command: { type: string; range: string }) => Reply | Promise<Reply>) {
  const sent: Array<{ type: string; range: string; timeZone?: string }> = [];
  const dispatch = vi.fn(async (request: { commandId: string; command: { type: string; range: string } }) => {
    sent.push(request.command);
    return { commandId: request.commandId, ...(await reply(request.command)) };
  });
  const bridge = {
    runtime: { getProjection: async () => undefined, onProjection: () => () => undefined, dispatch },
  } as unknown as ZliBridge;
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <RuntimeProvider bridge={bridge}>
        <UsageSection projection={undefined} />
      </RuntimeProvider>,
    );
  });
  return { container, sent };
}

const totals = (container: HTMLElement) =>
  Object.fromEntries(
    [...container.querySelectorAll(".usage-report-total")].map((item) => [
      item.querySelector("dt")?.textContent,
      item.querySelector("dd")?.textContent,
    ]),
  );

const press = async (container: HTMLElement, label: string) => {
  const button = [...container.querySelectorAll<HTMLButtonElement>(".segmented-item")].find(
    (item) => item.textContent === label,
  );
  await act(async () => button?.click());
};

describe("Usage page", () => {
  it("shows totals, the daily chart, and tables by agent and model", async () => {
    const { container, sent } = await render(() => ({ accepted: true, result: report() }));
    expect(sent[0]).toMatchObject({ type: "usage.read", range: "30d" });
    expect(totals(container)).toEqual({
      Cost: "$4.50",
      Tokens: "2.1M",
      Input: "1.1M",
      Output: "1k",
      "Cache read": "1M",
      "Cache write": "0",
    });
    expect(container.textContent).toContain("Cost leaves out 1M tokens from models without a known price.");
    expect(container.querySelectorAll(".usage-chart-bar")).toHaveLength(2);
    expect(container.querySelector(".usage-chart-detail")?.textContent).toContain("Nov 21");

    const modelRows = [...container.querySelectorAll(".usage-report-table")][1]?.querySelectorAll("tbody tr");
    expect([...(modelRows ?? [])].map((row) => row.lastElementChild?.textContent)).toEqual(["$4.50", "Unknown"]);
    expect(container.textContent).toContain("Unknown means ZLI has no price for that model.");
  });

  it("asks again when the range changes and switches the chart to tokens", async () => {
    const { container, sent } = await render((command) => ({
      accepted: true,
      result: report({ range: command.range as UsageReport["range"] }),
    }));
    await press(container, "7 days");
    expect(sent.at(-1)).toMatchObject({ range: "7d" });
    await press(container, "Tokens");
    expect(container.querySelector(".settings-group-title")?.textContent).toBe("Daily tokens");
    const bar = container.querySelectorAll<HTMLButtonElement>(".usage-chart-bar")[1];
    expect(bar?.getAttribute("aria-label")).toBe("Nov 21: 2.1M");
  });

  it("says when nothing was used, and shows errors with a way to try again", async () => {
    const empty = await render(() => ({
      accepted: true,
      result: report({
        totals: { tokens: tokens(0, 0), costUsd: 0, unpricedTokens: 0, requests: 0 },
        providers: [],
        models: [],
      }),
    }));
    expect(empty.container.textContent).toContain("No agent use in this range.");
    act(() => root?.unmount());
    document.body.replaceChildren();

    let fail = true;
    const failing = await render(() =>
      fail
        ? { accepted: false, error: { code: "internal", message: "Usage could not be read." } }
        : { accepted: true, result: report() },
    );
    expect(failing.container.querySelector('[role="alert"]')?.textContent).toContain("Usage could not be read.");
    fail = false;
    const retry = [...failing.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Try again",
    );
    await act(async () => retry?.click());
    expect(failing.container.querySelector('[role="alert"]')).toBeNull();
    expect(totals(failing.container).Cost).toBe("$4.50");
  });
});

describe("usage report helpers", () => {
  it("formats dollars for the amount", () => {
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(0.004)).toBe("under $0.01");
    expect(formatUsd(443.734)).toBe("$443.73");
    expect(formatUsd(3_442.1)).toBe("$3,442");
    expect(shortDate("2026-01-05")).toBe("Jan 5");
  });

  it("shows weeks instead of days for long ranges, ending on the last day", () => {
    const days = Array.from({ length: 100 }, (_, index) => ({
      date: new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10),
      tokens: 1,
      costUsd: 1,
      providers: [{ provider: "claude-code" as const, tokens: 1, costUsd: 1 }],
    }));
    const bars = chartBars(days);
    expect(bars).toHaveLength(15);
    expect(bars.at(-1)).toMatchObject({ tokens: 7, costUsd: 7, label: "Apr 4 – Apr 10" });
    expect(bars[0]).toMatchObject({ tokens: 2, label: "Jan 1 – Jan 2" });
    expect(chartBars(days.slice(0, 30))).toHaveLength(30);
  });
});
