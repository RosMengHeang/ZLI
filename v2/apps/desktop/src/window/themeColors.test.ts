import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { themeColors, themeColorTokens } from "@zli-v2/ui/colors";

const tokens = readFileSync(new URL("../../../../packages/ui/src/tokens.css", import.meta.url), "utf8");

describe("themeColors", () => {
  it.each(Object.keys(themeColors) as (keyof typeof themeColors)[])("%s matches tokens.css", (name) => {
    const property = themeColorTokens[name];
    const value = new RegExp(`${property}:\\s*([^;]+);`, "u").exec(tokens)?.[1]?.trim();
    expect(value?.toLowerCase()).toBe(themeColors[name]);
  });
});
