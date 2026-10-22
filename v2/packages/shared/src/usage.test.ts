import { describe, expect, it } from "vitest";

import { compactUsage, costAmount, growth, sumCounts, tokenCount } from "./usage.js";

describe("usage helpers", () => {
  it("accepts only whole, non-negative counts", () => {
    expect(tokenCount(12.4)).toBe(12);
    expect(tokenCount(-1)).toBeUndefined();
    expect(tokenCount("12")).toBeUndefined();
    expect(tokenCount(Number.NaN)).toBeUndefined();
    expect(costAmount(0.0123)).toBe(0.0123);
    expect(costAmount(-0.5)).toBeUndefined();
  });

  it("sums present counts and reports growth of running totals", () => {
    expect(sumCounts(undefined, 3, undefined, 4)).toBe(7);
    expect(sumCounts(undefined)).toBeUndefined();
    expect(growth(10, 4)).toBe(6);
    expect(growth(10, undefined)).toBe(10);
    expect(growth(3, 10)).toBe(3);
    expect(growth(undefined, 10)).toBeUndefined();
  });

  it("drops missing fields and empty results", () => {
    expect(compactUsage({ inputTokens: 5, outputTokens: undefined, contextWindow: 0 })).toEqual({ inputTokens: 5 });
    expect(compactUsage({ outputTokens: undefined })).toBeUndefined();
  });
});
