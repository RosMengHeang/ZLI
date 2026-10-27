// @vitest-environment jsdom

import type { Account, PlanLimitReading, PlanLimitWindow } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resetPlanLimitsStore } from "../limits/limits.js";
import type { ZliBridge } from "../runtime/bridge.js";
import { RuntimeProvider } from "../runtime/RuntimeProvider.js";
import { DEFAULT_SETTINGS, updateAppSettings } from "../settings/appSettings.js";
import { SidebarPlanLimits, SidebarUsageStrip } from "./SidebarUsageStrip.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// A Saturday, so a reset 3 days out lands on Tuesday.
const now = Date.parse("2026-01-10T12:00:00.000Z");
const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
const work = { id: "work", provider: "claude-code", kind: "sign-in", label: "Work" } as Account;

const fiveHour = (usedPercent: number, extra: Partial<PlanLimitWindow> = {}): PlanLimitWindow => ({
  durationMinutes: 300,
  usedPercent,
  resetsAt: at(47),
  ...extra,
});
const week = (usedPercent: number, extra: Partial<PlanLimitWindow> = {}): PlanLimitWindow => ({
  durationMinutes: 10_080,
  usedPercent,
  resetsAt: at(3 * 1_440 - 180),
  ...extra,
});

function reading(
  provider: string,
  windows: PlanLimitWindow[],
  extra: Partial<PlanLimitReading> = {},
): PlanLimitReading {
  return { provider, accountId: "usual", state: "ok", windows, ...extra } as PlanLimitReading;
}

async function render(
  readings: readonly PlanLimitReading[] | undefined,
  options: { currentKey?: string; hidden?: string[]; onOpen?: () => void } = {},
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
        hidden={options.hidden}
        timeZone="UTC"
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

// Intl puts a narrow no-break space before AM and PM.
const plain = (text: string | null | undefined) => (text ?? "").replace(/\u202f/gu, " ");

function description(target: HTMLButtonElement): string {
  const id = target.getAttribute("aria-describedby");
  return plain(id ? document.getElementById(id)?.textContent : "");
}

const lines = (container: HTMLElement) =>
  [...container.querySelectorAll(".usage-strip-window")].map((line) => plain(line.textContent));
const labels = (container: HTMLElement) =>
  [...container.querySelectorAll(".usage-strip-window-label")].map((label) => label.textContent);
const names = (container: HTMLElement) =>
  [...container.querySelectorAll(".usage-strip-name")].map((name) => name.textContent);

afterEach(() => document.body.replaceChildren());

describe("SidebarUsageStrip", () => {
  it("shows nothing while loading or when no login reports limits", async () => {
    expect((await render(undefined)).innerHTML).toBe("");
    expect((await render([])).innerHTML).toBe("");
    const apiKey = reading("codex", [], { state: "unavailable" });
    const neverSignedIn = reading("claude-code", [], { state: "signed-out" });
    expect((await render([apiKey, neverSignedIn])).innerHTML).toBe("");
  });

  it("draws a circle per limit with its share and reset, and opens Usage on click", async () => {
    let opened = 0;
    const container = await render([reading("codex", [fiveHour(34), week(12)])], { onOpen: () => (opened += 1) });
    const card = button(container);
    expect(card.getAttribute("aria-label")).toBe("Plan limits");
    expect(container.querySelectorAll(".usage-strip-ring")).toHaveLength(2);
    expect(lines(container)).toEqual(["5h34%47m · 12:47 PM", "Week12%2d 21h · Tue 9:00 AM"]);
    expect(card.textContent).not.toMatch(/\$|tokens/iu);
    expect(description(card)).toBe(
      "Codex: 34% of the 5-hour limit used, 47m at 12:47 PM; 12% of the weekly limit used, 2d 21h at Tue 9:00 AM.",
    );
    await act(async () => card.click());
    expect(opened).toBe(1);
  });

  it("fills the circle by the share used and warns from 80%", async () => {
    const container = await render([reading("claude-code", [fiveHour(86), week(100)])]);
    const [first, second] = container.querySelectorAll(".usage-strip-window");
    expect(first?.classList.contains("is-warning")).toBe(true);
    expect(second?.classList.contains("is-full")).toBe(true);
    const fill = first?.querySelector(".usage-strip-ring-fill")?.getAttribute("stroke-dasharray") ?? "";
    const [filled, total] = fill.split(" ").map(Number);
    expect((filled ?? 0) / (total ?? 1)).toBeCloseTo(0.86);
  });

  it("shows only the windows a plan has", async () => {
    const container = await render([reading("codex", [week(31)])]);
    expect(lines(container)).toEqual(["Week31%2d 21h · Tue 9:00 AM"]);
  });

  it("explains a missing reset instead of making one up", async () => {
    const container = await render([
      reading("claude-code", [fiveHour(0, { resetsAt: undefined }), week(40, { resetsAt: undefined })]),
    ]);
    expect(lines(container)).toEqual(["5h0%Starts when used", "Week40%Reset time unknown"]);
  });

  it("hides an old share once its window has reset", async () => {
    const container = await render([reading("codex", [fiveHour(95, { resetsAt: at(-2) }), week(12)])]);
    expect(lines(container)[0]).toBe("5h–Reset, checking");
    expect(description(button(container))).toContain("the 5-hour limit just reset");
  });

  it("adds the model limit that will stop the agent first", async () => {
    const container = await render([
      reading("claude-code", [fiveHour(10), week(41), week(92, { scope: "Fable" }), week(5, { scope: "Sonnet" })]),
    ]);
    expect(labels(container)).toEqual(["5h", "Week", "Fable"]);
  });

  it("names saved accounts and the usual login beside them", async () => {
    const container = await render([
      reading("claude-code", [fiveHour(10)]),
      reading("claude-code", [week(63)], { accountId: "work" }),
      reading("codex", [fiveHour(34)]),
    ]);
    expect(names(container)).toEqual(["Claude CodeUsual login", "Claude CodeWork", "Codex"]);
  });

  it("says why a saved login has no numbers, and dims old ones", async () => {
    const container = await render([
      reading("claude-code", [], { accountId: "work", state: "expired", message: "Sign in again, please." }),
      reading("codex", [fiveHour(34)], { state: "error", message: "Codex did not answer." }),
    ]);
    expect(names(container)).toEqual(["Claude CodeWorkSign in again", "CodexCould not check"]);
    const rows = container.querySelectorAll(".usage-strip-row");
    expect(rows[1]?.classList.contains("is-stale")).toBe(true);
    expect(rows[1]?.getAttribute("title")).toBe("Codex did not answer.");
    expect(description(button(container))).toContain("Claude Code, Work: Sign in again, please.");
  });

  it("caps at three logins but keeps the selected agent's login in view", async () => {
    const container = await render(
      [
        reading("claude-code", [fiveHour(1)]),
        reading("claude-code", [fiveHour(2)], { accountId: "work" }),
        reading("codex", [fiveHour(3)]),
        reading("codex", [fiveHour(4)], { accountId: "spare" }),
        reading("codex", [fiveHour(5)], { accountId: "other" }),
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

  it("leaves out a usual login whose limits were never read, and agents switched off", async () => {
    const container = await render(
      [
        reading("codex", [], { state: "error", message: "Codex did not answer." }),
        reading("opencode", [], { state: "expired" }),
        reading("claude-code", [fiveHour(10)]),
        reading("gemini", [fiveHour(5)]),
      ],
      { hidden: ["gemini"] },
    );
    expect(names(container)).toEqual(["Claude Code"]);
  });
});

describe("SidebarPlanLimits", () => {
  afterEach(() => {
    window.localStorage.clear();
    updateAppSettings(() => structuredClone(DEFAULT_SETTINGS));
    resetPlanLimitsStore();
  });

  async function mount() {
    const dispatch = vi.fn(async (request: { commandId: string }) => ({
      commandId: request.commandId,
      accepted: true,
      result: { readings: [reading("claude-code", [fiveHour(10)]), reading("codex", [fiveHour(20)])] },
    }));
    const bridge = {
      runtime: { getProjection: async () => undefined, onProjection: () => () => undefined, dispatch },
    } as unknown as ZliBridge;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <RuntimeProvider bridge={bridge}>
          <SidebarPlanLimits providers={undefined} accounts={[]} now={now} timeZone="UTC" onOpen={() => undefined} />
        </RuntimeProvider>,
      );
    });
    return { container, dispatch, root };
  }

  it("is off by default and reads no limits", async () => {
    const { container, dispatch, root } = await mount();
    expect(container.innerHTML).toBe("");
    expect(dispatch).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("shows the agents left on once turned on in Settings", async () => {
    updateAppSettings((current) => ({ ...current, sidebarLimits: { enabled: true, hidden: ["codex"] } }));
    const { container, dispatch, root } = await mount();
    expect(dispatch).toHaveBeenCalled();
    expect(names(container)).toEqual(["Claude Code"]);
    act(() => root.unmount());
  });
});
