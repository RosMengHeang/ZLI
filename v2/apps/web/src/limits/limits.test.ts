import { describe, expect, it } from "vitest";

import { formatPercent, formatResetIn, limitKey, limitWindows, readPlanLimits } from "./limits.js";

const now = Date.parse("2026-01-10T12:00:00.000Z");
const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();

describe("limitWindows", () => {
  it("sorts windows by length", () => {
    const result = limitWindows({
      windows: [
        { durationMinutes: 10_080, usedPercent: 12 },
        { durationMinutes: 300, usedPercent: 34 },
      ],
    });
    expect(result.fiveHour?.usedPercent).toBe(34);
    expect(result.week?.usedPercent).toBe(12);
  });

  it("falls back to order when a window has no length", () => {
    const result = limitWindows({ windows: [{ usedPercent: 5 }, { usedPercent: 50 }] });
    expect(result.fiveHour?.usedPercent).toBe(5);
    expect(result.week?.usedPercent).toBe(50);
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
