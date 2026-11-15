import { describe, expect, it } from "vitest";

import { BUDDY_COLOR_NAMES, buddyHex, buddyName, parseBuddy } from "./buddies.js";

describe("buddies", () => {
  it("reads every saved look as a color", () => {
    expect(parseBuddy("sky")).toBe("sky");
    // Looks saved while buddies had bodies keep their color.
    expect(parseBuddy("cloud")).toBe("sky");
    expect(parseBuddy("cloud/jade")).toBe("jade");
    expect(parseBuddy("squircle")).toBe("paper");
    // And looks saved while teammates were animals.
    expect(parseBuddy("owl")).toBe("paper");
    expect(parseBuddy("fox")).toBe("tangerine");
    expect(parseBuddy("dragon")).toBeUndefined();
    expect(parseBuddy("cloud/dragon")).toBe("sky");
    expect(parseBuddy(3)).toBeUndefined();
  });

  it("names and paints a buddy by its color", () => {
    expect(buddyName("sky")).toBe("Sky");
    expect(buddyHex("sky")).toBe("#4aa8ff");
  });

  it("lists the 12 colors in picker order", () => {
    expect(BUDDY_COLOR_NAMES).toEqual([
      "sky",
      "indigo",
      "orchid",
      "rose",
      "tomato",
      "tangerine",
      "butter",
      "lime",
      "jade",
      "clay",
      "paper",
      "slate",
    ]);
  });
});
