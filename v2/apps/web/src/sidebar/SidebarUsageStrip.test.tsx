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
  options: { currentKey?: string; hidden?: string[]; onOpenSettings?: () => void; open?: boolean } = {},
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
        onOpenSettings={options.onOpenSettings ?? (() => undefined)}
      />,
    );
  });
  if (options.open) await act(async () => toggle(container).click());
  return container;
}

function toggle(container: HTMLElement): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(".usage-strip-toggle");
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
const summary = (container: HTMLElement) => container.querySelector(".usage-strip-summary")?.textContent;

afterEach(() => {
  document.body.replaceChildren();
  window.localStorage.clear();
});

describe("SidebarUsageStrip", () => {
  it("shows nothing while loading or when no login reports limits", async () => {
    expect((await render(undefined)).innerHTML).toBe("");
    expect((await render([])).innerHTML).toBe("");
    const apiKey = reading("codex", [], { state: "unavailable" });
    const neverSignedIn = reading("claude-code", [], { state: "signed-out" });
    expect((await render([apiKey, neverSignedIn])).innerHTML).toBe("");
  });

  it("starts folded to one line with the fullest limit, and still describes every login", async () => {
    const container = await render([
      reading("claude-code", [fiveHour(10), week(41)]),
      reading("codex", [fiveHour(86), week(12)]),
    ]);
    const card = toggle(container);
    expect(card.getAttribute("aria-label")).toBe("Plan limits");
    expect(card.getAttribute("aria-expanded")).toBe("false");
    expect(summary(container)).toBe("Codex5h86%");
    expect(container.querySelector(".usage-strip-summary")?.classList.contains("is-warning")).toBe(true);
    expect(container.querySelectorAll(".usage-strip-row")).toHaveLength(0);
    expect(card.textContent).not.toMatch(/\$|tokens/iu);
    expect(description(card)).toContain("Claude Code: 10% of the 5-hour limit used");
    expect(description(card)).toContain("Codex: 86% of the 5-hour limit used");
  });

  it("sums up the selected agent's login while folded", async () => {
    const container = await render(
      [reading("claude-code", [fiveHour(10), week(41)]), reading("codex", [fiveHour(86)])],
      { currentKey: "claude-code:usual" },
    );
    expect(summary(container)).toBe("Claude CodeWeek41%");
  });

  it("skips a window that just reset when summing up", async () => {
    const container = await render([reading("codex", [fiveHour(95, { resetsAt: at(-2) }), week(12)])]);
    expect(summary(container)).toBe("CodexWeek12%");
  });

  it("says why the summed-up login has no numbers", async () => {
    const container = await render([reading("claude-code", [], { accountId: "work", state: "expired" })]);
    expect(summary(container)).toBe("Claude CodeWorkSign in again");
  });

  it("unfolds to a circle per limit with one reset format, and remembers it", async () => {
    const container = await render([reading("codex", [fiveHour(34), week(12)])], { open: true });
    const card = toggle(container);
    expect(card.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(".usage-strip-summary")).toBeNull();
    expect(container.querySelectorAll(".usage-strip-ring")).toHaveLength(2);
    expect(lines(container)).toEqual(["5h34%Resets in 47m", "Week12%Resets in 2d 21h"]);
    const resets = [...container.querySelectorAll(".usage-strip-window-reset")];
    expect(resets.map((reset) => plain(reset.getAttribute("data-tooltip")))).toEqual([
      "Resets 12:47 PM",
      "Resets Tue 9:00 AM",
    ]);
    expect(labels(container).length).toBe(2);
    expect(
      [...container.querySelectorAll(".usage-strip-window-label")].map((label) => label.getAttribute("data-tooltip")),
    ).toEqual(["5-hour limit", "Weekly limit"]);
    expect(description(card)).toBe(
      "Codex: 34% of the 5-hour limit used, resets in 47m at 12:47 PM; 12% of the weekly limit used, resets in 2d 21h at Tue 9:00 AM.",
    );

    document.body.replaceChildren();
    const again = await render([reading("codex", [fiveHour(34)])]);
    expect(toggle(again).getAttribute("aria-expanded")).toBe("true");
    await act(async () => toggle(again).click());
    expect(toggle(again).getAttribute("aria-expanded")).toBe("false");
    expect(window.localStorage.getItem("zli.sidebar.limitsOpen")).toBeNull();
  });

  it("opens Settings from the unfolded card", async () => {
    const onOpenSettings = vi.fn();
    const container = await render([reading("codex", [fiveHour(34)])], { open: true, onOpenSettings });
    const choose = [...container.querySelectorAll("button")].find((button) => button.textContent === "Choose agents");
    await act(async () => choose?.click());
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("fills the circle by the share used and warns from 80%", async () => {
    const container = await render([reading("claude-code", [fiveHour(86), week(100)])], { open: true });
    const [first, second] = container.querySelectorAll(".usage-strip-window");
    expect(first?.classList.contains("is-warning")).toBe(true);
    expect(second?.classList.contains("is-full")).toBe(true);
    const fill = first?.querySelector(".usage-strip-ring-fill")?.getAttribute("stroke-dasharray") ?? "";
    const [filled, total] = fill.split(" ").map(Number);
    expect((filled ?? 0) / (total ?? 1)).toBeCloseTo(0.86);
  });

  it("shows only the windows a plan has", async () => {
    const container = await render([reading("codex", [week(31)])], { open: true });
    expect(lines(container)).toEqual(["Week31%Resets in 2d 21h"]);
  });

  it("explains a missing reset instead of making one up", async () => {
    const container = await render(
      [reading("claude-code", [fiveHour(0, { resetsAt: undefined }), week(40, { resetsAt: undefined })])],
      { open: true },
    );
    expect(lines(container)).toEqual(["5h0%Starts when used", "Week40%Reset time unknown"]);
  });

  it("hides an old share once its window has reset", async () => {
    const container = await render([reading("codex", [fiveHour(95, { resetsAt: at(-2) }), week(12)])], {
      open: true,
    });
    expect(lines(container)[0]).toBe("5h–Reset, checking");
    expect(description(toggle(container))).toContain("the 5-hour limit just reset");
  });

  it("adds the model limit that will stop the agent first", async () => {
    const container = await render(
      [reading("claude-code", [fiveHour(10), week(41), week(92, { scope: "Fable" }), week(5, { scope: "Sonnet" })])],
      { open: true },
    );
    expect(labels(container)).toEqual(["5h", "Week", "Fable"]);
  });

  it("names the usual login only beside another login of the same agent", async () => {
    const container = await render(
      [
        reading("claude-code", [fiveHour(10)]),
        reading("claude-code", [week(63)], { accountId: "work" }),
        reading("codex", [fiveHour(34)]),
      ],
      { open: true },
    );
    expect(names(container)).toEqual(["Claude CodeUsual login", "Claude CodeWork", "Codex"]);
  });

  it("says why a saved login has no numbers, and dims old ones", async () => {
    const container = await render(
      [
        reading("claude-code", [], { accountId: "work", state: "expired", message: "Sign in again, please." }),
        reading("codex", [fiveHour(34)], { state: "error", message: "Codex did not answer." }),
      ],
      { open: true },
    );
    expect(names(container)).toEqual(["Claude CodeWorkSign in again", "CodexCould not check"]);
    const rows = container.querySelectorAll(".usage-strip-row");
    expect(rows[1]?.classList.contains("is-stale")).toBe(true);
    expect(rows[1]?.getAttribute("title")).toBe("Codex did not answer.");
    expect(description(toggle(container))).toContain("Claude Code, Work: Sign in again, please.");
  });

  it("lists every login once unfolded and marks the selected agent's", async () => {
    const container = await render(
      [
        reading("claude-code", [fiveHour(1)]),
        reading("claude-code", [fiveHour(2)], { accountId: "work" }),
        reading("codex", [fiveHour(3)]),
        reading("codex", [fiveHour(4)], { accountId: "spare" }),
        reading("codex", [fiveHour(5)], { accountId: "other" }),
      ],
      { currentKey: "codex:other", open: true },
    );
    const rows = container.querySelectorAll(".usage-strip-row");
    expect(rows).toHaveLength(5);
    expect(rows[4]?.classList.contains("is-current")).toBe(true);
    expect(container.querySelectorAll(".is-current")).toHaveLength(1);
    expect(description(toggle(container))).toContain("selected agent");
  });

  it("leaves out a usual login whose limits were never read, and agents switched off", async () => {
    const container = await render(
      [
        reading("codex", [], { state: "error", message: "Codex did not answer." }),
        reading("opencode", [], { state: "expired" }),
        reading("claude-code", [fiveHour(10)]),
        reading("gemini", [fiveHour(5)]),
      ],
      { hidden: ["gemini"], open: true },
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
          <SidebarPlanLimits
            providers={undefined}
            accounts={[]}
            now={now}
            timeZone="UTC"
            onOpenSettings={() => undefined}
          />
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
    window.localStorage.setItem("zli.sidebar.limitsOpen", "1");
    const { container, dispatch, root } = await mount();
    expect(dispatch).toHaveBeenCalled();
    expect(names(container)).toEqual(["Claude Code"]);
    act(() => root.unmount());
  });
});
