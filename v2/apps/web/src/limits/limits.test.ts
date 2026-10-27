import { describe, expect, it } from "vitest";
import type { PlanLimitReading, PlanLimitWindow } from "@zli-v2/contracts";

import {
  formatPercent,
  formatResetClock,
  formatResetIn,
  limitKey,
  readPlanLimits,
  resetText,
  showsReading,
  visibleWindows,
  windowLabel,
  windowName,
} from "./limits.js";

const now = Date.parse("2026-01-10T12:00:00.000Z");
const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();

const usage = (
  durationMinutes: number,
  usedPercent: number,
  extra: Partial<PlanLimitWindow> = {},
): PlanLimitWindow => ({
  durationMinutes,
  usedPercent,
  ...extra,
});

// Intl puts a narrow no-break space before AM and PM.
const plain = (text: string | undefined) => text?.replace(/\u202f/gu, " ");

describe("visibleWindows", () => {
  it("shows every whole-plan window, shortest first", () => {
    const windows = visibleWindows({ windows: [usage(10_080, 12), usage(300, 34)] });
    expect(windows.map(windowLabel)).toEqual(["5h", "Week"]);
  });

  it("shows one circle for a weekly-only plan, not an empty 5-hour one", () => {
    expect(visibleWindows({ windows: [usage(10_080, 31)] }).map(windowLabel)).toEqual(["Week"]);
  });

  it("adds a model limit only when it is the one that will stop the agent", () => {
    const quiet = { windows: [usage(300, 10), usage(10_080, 50), usage(10_080, 20, { scope: "Sonnet" })] };
    expect(visibleWindows(quiet).map(windowLabel)).toEqual(["5h", "Week"]);
    const tight = { windows: [usage(300, 10), usage(10_080, 50), usage(10_080, 70, { scope: "Fable" })] };
    expect(visibleWindows(tight).map(windowLabel)).toEqual(["5h", "Week", "Fable"]);
    const nearlyFull = { windows: [usage(10_080, 95), usage(10_080, 85, { scope: "Opus" })] };
    expect(visibleWindows(nearlyFull).map(windowLabel)).toEqual(["Week", "Opus"]);
  });

  it("shows a paid monthly cap only when the plan has no windows of its own", () => {
    const spend = usage(43_200, 40, { kind: "spend" });
    expect(visibleWindows({ windows: [usage(300, 1), spend] }).map(windowLabel)).toEqual(["5h"]);
    expect(visibleWindows({ windows: [spend] }).map(windowLabel)).toEqual(["Extra"]);
  });

  it("caps a row at three circles", () => {
    const windows = [
      usage(300, 90),
      usage(10_080, 81),
      usage(10_080, 99, { scope: "Fable" }),
      usage(10_080, 95, { scope: "Opus" }),
    ];
    expect(visibleWindows({ windows }).map(windowLabel)).toEqual(["5h", "Week", "Fable"]);
  });
});

describe("windowLabel and windowName", () => {
  it("names windows by length, never by slot", () => {
    expect([300, 1_440, 10_080, 43_200, 44_640, 120, 4_320].map((minutes) => windowLabel(usage(minutes, 0)))).toEqual([
      "5h",
      "Day",
      "Week",
      "Month",
      "Month",
      "2h",
      "3d",
    ]);
    expect(windowLabel({ usedPercent: 1 })).toBe("Limit");
    expect(windowName(usage(300, 0))).toBe("5-hour");
    expect(windowName(usage(10_080, 0, { scope: "Fable" }))).toBe("Fable weekly");
    expect(windowName(usage(43_200, 0, { kind: "spend" }))).toBe("extra usage");
  });
});

describe("showsReading", () => {
  const reading = (extra: Partial<PlanLimitReading>): PlanLimitReading => ({
    provider: "codex",
    accountId: "usual",
    state: "ok",
    windows: [usage(300, 1)],
    ...extra,
  });

  it("hides logins with no plan limits and a usual login nobody signed in to", () => {
    expect(showsReading(reading({}))).toBe(true);
    expect(showsReading(reading({ state: "unavailable", windows: [] }))).toBe(false);
    expect(showsReading(reading({ windows: [] }))).toBe(false);
    expect(showsReading(reading({ state: "signed-out", windows: [] }))).toBe(false);
    expect(showsReading(reading({ state: "signed-out", accountId: "work", windows: [] }))).toBe(true);
    expect(showsReading(reading({ state: "expired", windows: [] }))).toBe(true);
  });
});

describe("resetText", () => {
  it("always says something about the reset, without making one up", () => {
    expect(plain(resetText(usage(300, 34, { resetsAt: at(130) }), now, "UTC").text)).toBe("2h 10m · 2:10 PM");
    expect(resetText(usage(300, 0), now).text).toBe("Starts when used");
    expect(resetText(usage(300, 20), now).text).toBe("Reset time unknown");
    expect(resetText(usage(43_200, 20, { kind: "spend" }), now).text).toBe("Resets monthly");
    expect(resetText(usage(300, 90, { resetsAt: at(-1) }), now)).toEqual({ text: "Reset, checking", passed: true });
  });
});

describe("formatResetClock", () => {
  it("gives the time today, the weekday this week, and the date later", () => {
    expect(plain(formatResetClock(at(47), now, "UTC"))).toBe("12:47 PM");
    expect(plain(formatResetClock(at(3 * 1_440 - 180), now, "UTC"))).toBe("Tue 9 AM");
    expect(plain(formatResetClock(at(20 * 1_440), now, "UTC"))).toBe("Jan 30");
    expect(plain(formatResetClock("later", now, "UTC"))).toBeUndefined();
  });
});
describe("formatPercent", () => {
  it("never rounds up to a spent window", () => {
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(33.6)).toBe("34%");
    expect(formatPercent(99.7)).toBe("99%");
    expect(formatPercent(100)).toBe("100%");
  });
});

describe("formatResetIn", () => {
  it("counts down from the real reset time only", () => {
    expect(formatResetIn(undefined, now)).toBeUndefined();
    expect(formatResetIn("soon", now)).toBeUndefined();
    expect(formatResetIn(at(-5), now)).toBe("under a minute");
    expect(formatResetIn(at(47), now)).toBe("47m");
    expect(formatResetIn(at(192), now)).toBe("3h 12m");
    expect(formatResetIn(at(120), now)).toBe("2h");
    expect(formatResetIn(at(52 * 60), now)).toBe("2d 4h");
    expect(formatResetIn(at(3 * 1_440), now)).toBe("3d");
  });
});

describe("limitKey", () => {
  it("treats a missing account as the usual login", () => {
    expect(limitKey("codex", undefined)).toBe("codex:usual");
    expect(limitKey("codex", "work")).toBe("codex:work");
  });
});

describe("readPlanLimits", () => {
  const readings = [{ provider: "codex", accountId: "usual", state: "ok", windows: [] }];

  it("asks the runtime and checks the answer", async () => {
    const sent: unknown[] = [];
    const result = await readPlanLimits(async (request) => {
      sent.push(request);
      return { commandId: "c", accepted: true, result: { readings } } as never;
    }, true);
    expect(result).toEqual(readings);
    expect(sent[0]).toMatchObject({ command: { type: "limits.read", refresh: true } });
  });

  it("treats a runtime without limits as having none", async () => {
    const result = await readPlanLimits(
      async () =>
        ({
          commandId: "c",
          accepted: false,
          error: { code: "unavailable", message: "No", retryable: false },
        }) as never,
    );
    expect(result).toEqual([]);
  });

  it("rejects an unexpected answer", async () => {
    await expect(
      readPlanLimits(async () => ({ commandId: "c", accepted: true, result: { nope: 1 } }) as never),
    ).rejects.toThrow("unexpected");
  });
});
