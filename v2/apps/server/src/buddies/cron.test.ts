import { describe, expect, it } from "vitest";

import { isValidCron, latestSlot, nextSlot, parseCron } from "./cron.js";

describe("cron", () => {
  it("finds the next weekday 9:00 slot", () => {
    const cron = parseCron("0 9 * * 1-5");
    // Saturday 15 Nov 2025, 10:00 local.
    const next = nextSlot(cron, new Date(2025, 10, 15, 10, 0));
    expect(next?.getDay()).toBe(1);
    expect(next?.getHours()).toBe(9);
  });

  it("collapses missed slots into the latest one", () => {
    const cron = parseCron("*/15 * * * *");
    const slot = latestSlot(cron, new Date(2025, 0, 1, 8, 0), new Date(2025, 0, 1, 9, 7));
    expect(slot?.getHours()).toBe(9);
    expect(slot?.getMinutes()).toBe(0);
    expect(latestSlot(cron, new Date(2025, 0, 1, 9, 1), new Date(2025, 0, 1, 9, 7))).toBeUndefined();
  });

  it("rejects bad schedules", () => {
    expect(isValidCron("61 * * * *")).toBe(false);
    expect(isValidCron("0 9 * *")).toBe(false);
    expect(isValidCron("0 17 * * 5")).toBe(true);
  });
});
