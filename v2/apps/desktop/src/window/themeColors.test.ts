import { readFileSync } from "node:fs";

import { themeColors, themeColorTokens } from "@zli-v2/ui/colors";
import { DEFAULT_THEME, THEMES } from "@zli-v2/ui/themes";
import { describe, expect, it } from "vitest";

const tokens = readFileSync(new URL("../../../../packages/ui/src/tokens.css", import.meta.url), "utf8");

function cssValue(property: string): string | undefined {
  return new RegExp(`${property}:\\s*([^;]+);`, "u").exec(tokens)?.[1]?.trim();
}

describe("themeColors", () => {
  it.each(Object.keys(themeColors) as (keyof typeof themeColors)[])("%s matches tokens.css", (name) => {
    expect(cssValue(themeColorTokens[name])?.toLowerCase()).toBe(themeColors[name]);
  });

  it("keeps tokens.css equal to the default theme", () => {
    expect(DEFAULT_THEME).toBe("midnight");
    for (const [property, value] of Object.entries(THEMES.midnight.tokens)) {
      expect(cssValue(property), property).toBe(value);
    }
  });
});
