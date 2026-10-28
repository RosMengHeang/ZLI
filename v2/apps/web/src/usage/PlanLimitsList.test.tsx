// @vitest-environment jsdom

import type { PlanLimitReading, ProviderDiscovery } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { limitRows, PlanLimitsList } from "./PlanLimitsList.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const now = Date.parse("2026-01-10T12:00:00.000Z");
const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();

const providers: ProviderDiscovery[] = [
  { provider: "cursor-agent", displayName: "Cursor", status: "found", path: "cursor-agent" },
  { provider: "kimi", displayName: "Kimi Code", status: "found", path: "kimi" },
  { provider: "droid", displayName: "Droid", status: "found", path: "droid" },
  { provider: "qwen", displayName: "Qwen Code", status: "found", path: "qwen" },
  { provider: "goose", displayName: "Goose", status: "missing" },
] as ProviderDiscovery[];

const readings: PlanLimitReading[] = [
  {
    provider: "cursor-agent",
    accountId: "usual",
    state: "ok",
    plan: "pro",
    windows: [{ durationMinutes: 43_200, usedPercent: 44, resetsAt: at(12 * 1_440) }],
  },
  {
    provider: "kimi",
    accountId: "usual",
    state: "expired",
    message: "The Kimi Code sign-in has expired. Sign in again in Kimi Code.",
    windows: [],
  },
  {
    provider: "droid",
    accountId: "usual",
    state: "ok",
    windows: [
      { durationMinutes: 300, usedPercent: 4, resetsAt: at(220) },
      { durationMinutes: 10_080, usedPercent: 25, resetsAt: at(4 * 1_440) },
      { scope: "Core", durationMinutes: 300, usedPercent: 0 },
      { scope: "Core", durationMinutes: 10_080, usedPercent: 85, resetsAt: at(2 * 1_440) },
    ],
  },
];

async function render(element: React.ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => createRoot(container).render(element));
  return container;
}

afterEach(() => document.body.replaceChildren());

describe("PlanLimitsList", () => {
  it("lists every installed agent, with the reason when it has no limits to show", async () => {
    const container = await render(
      <PlanLimitsList
        state={{ status: "ready", readings }}
        providers={providers}
        accounts={[]}
        now={now}
        timeZone="UTC"
      />,
    );
    const rows = [...container.querySelectorAll(".usage-limits > li")];
    expect(rows.map((row) => row.querySelector(".usage-limit-provider")?.textContent)).toEqual([
      "Cursor",
      "Kimi Code",
      "Droid",
      "Qwen Code",
    ]);
    expect(rows[0]?.textContent).toContain("pro");
    expect(rows[0]?.querySelector(".usage-limit-window-percent")?.textContent).toBe("44%");
    expect(rows[1]?.querySelector(".usage-limit-state")?.textContent).toBe("Expired");
    expect(rows[1]?.textContent).toContain("Sign in again in Kimi Code.");
    expect(rows[3]?.textContent).toContain("No plan limits");
    expect(rows[3]?.textContent).toContain("Qwen Code does not report plan limits.");
  });

  it("shows every window, naming pools that have more than one", async () => {
    const container = await render(
      <PlanLimitsList
        state={{ status: "ready", readings }}
        providers={providers}
        accounts={[]}
        now={now}
        timeZone="UTC"
      />,
    );
    const droid = container.querySelector('[aria-label="Droid limits"]');
    expect([...(droid?.querySelectorAll(".usage-limit-window-label") ?? [])].map((label) => label.textContent)).toEqual(
      ["5h", "Week", "Core 5h", "Core week"],
    );
    expect(droid?.querySelectorAll(".usage-limit-window.is-warning")).toHaveLength(1);
    expect(droid?.querySelectorAll(".usage-limit-window-reset")[2]?.textContent).toBe("Starts when used");
  });

  it("names what it is checking, and says when the check failed", async () => {
    const loading = await render(
      <PlanLimitsList state={{ status: "loading" }} providers={providers} accounts={[]} now={now} />,
    );
    expect(loading.textContent).toContain("Checking plan limits");
    const failed = await render(
      <PlanLimitsList
        state={{ status: "error", message: "ZLI is not connected to its runtime.", readings: [] }}
        providers={[]}
        accounts={[]}
        now={now}
      />,
    );
    expect(failed.querySelector('[role="alert"]')?.textContent).toBe(
      "Plan limits could not be checked. ZLI is not connected to its runtime.",
    );
    expect(failed.textContent).toContain("No agent CLIs were found on this computer.");
  });
});

describe("limitRows", () => {
  it("labels the usual login only when the agent also has saved accounts", () => {
    const rows = limitRows(
      [
        { provider: "droid", accountId: "usual", state: "ok", windows: [] },
        { provider: "droid", accountId: "team", state: "ok", windows: [] },
        { provider: "kimi", accountId: "usual", state: "ok", windows: [] },
      ],
      [],
      [{ id: "team", provider: "droid", label: "Team", kind: "api-key" }] as never,
    );
    expect(rows.map((row) => [row.provider, row.account])).toEqual([
      ["droid", "Usual login"],
      ["droid", "Team"],
      ["kimi", undefined],
    ]);
  });
});
