// @vitest-environment jsdom

import type { Account, PlanLimitReading } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { SidebarUsageStrip } from "./SidebarUsageStrip.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const now = Date.parse("2026-01-10T12:00:00.000Z");
const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
const work = { id: "work", provider: "claude-code", kind: "sign-in", label: "Work" } as Account;

function reading(
  provider: string,
  fiveHour: number | undefined,
  week: number | undefined,
  extra: Partial<PlanLimitReading> = {},
): PlanLimitReading {
  return {
    provider,
    accountId: "usual",
    state: "ok",
    windows: [
      ...(fiveHour === undefined ? [] : [{ durationMinutes: 300, usedPercent: fiveHour, resetsAt: at(47) }]),
      ...(week === undefined ? [] : [{ durationMinutes: 10_080, usedPercent: week, resetsAt: at(3 * 1_440) }]),
    ],
    ...extra,
  } as PlanLimitReading;
}

async function render(
  readings: readonly PlanLimitReading[] | undefined,
  options: { currentKey?: string; onOpen?: () => void } = {},
) {
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    createRoot(container).render(
      <SidebarUsageStrip
        readings={readings}
        providers={undefined}
        accounts={[work]}
        now={now}
        currentKey={options.currentKey}
        onOpen={options.onOpen ?? (() => undefined)}
      />,
    );
  });
  return container;
}

function button(container: HTMLElement): HTMLButtonElement {
  const found = container.querySelector("button");
  if (!found) throw new Error("No limits card");
  return found;
}

function description(target: HTMLButtonElement): string {
  const id = target.getAttribute("aria-describedby");
  return (id && document.getElementById(id)?.textContent) || "";
}

const rowTexts = (container: HTMLElement) =>
  [...container.querySelectorAll(".usage-strip-row")].map((row) => row.textContent);

afterEach(() => document.body.replaceChildren());

describe("SidebarUsageStrip", () => {
  it("shows nothing while loading or when no login reports limits", async () => {
    expect((await render(undefined)).innerHTML).toBe("");
    expect((await render([])).innerHTML).toBe("");
  });

  it("shows the share of each window used, and opens Usage on click", async () => {
    let opened = 0;
    const container = await render([reading("codex", 34, 12)], { onOpen: () => (opened += 1) });
    const card = button(container);
    expect(card.getAttribute("aria-label")).toBe("Plan limits");
    expect(rowTexts(container)).toEqual(["Codex34%12%"]);
    expect(card.textContent).not.toMatch(/\$|tokens/iu);
    expect(description(card)).toBe(
      "Codex: 34% of the 5-hour limit used, resets in 47m, 12% of the weekly limit used, resets in 3d.",
    );
    await act(async () => card.click());
    expect(opened).toBe(1);
  });

  it("warns at 80% and says when that window resets", async () => {
    const container = await render([reading("claude-code", 86, 41)]);
    expect(container.querySelector(".usage-strip-window.is-warning")?.textContent).toBe("86%");
    expect(container.querySelector(".usage-strip-reset")?.textContent).toBe("5h resets in 47m");
  });

  it("never makes up a reset time", async () => {
    const container = await render([
      { ...reading("codex", 90, undefined), windows: [{ durationMinutes: 300, usedPercent: 90 }] },
    ]);
    expect(container.querySelector(".usage-strip-reset")).toBeNull();
    expect(rowTexts(container)).toEqual(["Codex90%-"]);
    expect(description(button(container))).toBe("Codex: 90% of the 5-hour limit used.");
  });

  it("names saved accounts and the usual login beside them", async () => {
    const container = await render([
      reading("claude-code", 10, 20),
      reading("claude-code", 8, 63, { accountId: "work" }),
      reading("codex", 34, 12),
    ]);
    expect(rowTexts(container)).toEqual(["Claude CodeUsual login10%20%", "Claude CodeWork8%63%", "Codex34%12%"]);
  });

  it("says why a login has no numbers, and dims old ones", async () => {
    const container = await render([
      reading("claude-code", undefined, undefined, { state: "expired", message: "Sign in again, please." }),
      reading("codex", 34, 12, { state: "error", message: "Codex did not answer." }),
    ]);
    expect(rowTexts(container)).toEqual(["Claude CodeSign in again", "Codex34%12%"]);
    const rows = container.querySelectorAll(".usage-strip-row");
    expect(rows[1]?.classList.contains("is-stale")).toBe(true);
    expect(rows[1]?.getAttribute("title")).toBe("Codex did not answer.");
    expect(description(button(container))).toContain("Claude Code: Sign in again, please.");
  });

  it("caps at three rows but keeps the selected agent's login in view", async () => {
    const container = await render(
      [
        reading("claude-code", 1, 1),
        reading("claude-code", 2, 2, { accountId: "work" }),
        reading("codex", 3, 3),
        reading("codex", 4, 4, { accountId: "spare" }),
        reading("codex", 5, 5, { accountId: "other" }),
      ],
      { currentKey: "codex:other" },
    );
    const rows = container.querySelectorAll(".usage-strip-row");
    expect(rows).toHaveLength(3);
    expect(rows[2]?.classList.contains("is-current")).toBe(true);
    expect(rows[2]?.textContent).toContain("5%");
    expect(container.querySelector(".usage-strip-more")?.textContent).toBe("+2 more");
    expect(description(button(container))).toContain("selected agent");
  });
});
