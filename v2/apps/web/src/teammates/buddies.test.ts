import { describe, expect, it } from "vitest";

import { buddyBody, buddyColor, buddyName, makeBuddy, parseBuddy } from "./buddies.js";

describe("buddies", () => {
  it("reads a body alone as that body in its own color", () => {
    expect(parseBuddy("cloud")).toBe("cloud");
    expect(buddyColor("cloud")).toBe("sky");
    expect(buddyName("cloud")).toBe("Cloud");
  });

  it("keeps a body with a picked color, and drops a color it does not know", () => {
    expect(parseBuddy("cloud/jade")).toBe("cloud/jade");
    expect(buddyBody("cloud/jade")).toBe("cloud");
    expect(buddyColor("cloud/jade")).toBe("jade");
    expect(parseBuddy("cloud/neon")).toBe("cloud");
    expect(parseBuddy("dragon/jade")).toBeUndefined();
    expect(parseBuddy(42)).toBeUndefined();
  });

  it("turns the old animals into buddies, so saved looks carry over", () => {
    expect(parseBuddy("fox")).toBe("gumdrop");
    expect(parseBuddy("owl")).toBe("squircle");
    expect(parseBuddy("otter")).toBe("jelly");
    expect(parseBuddy("cat")).toBe("cloud");
    expect(parseBuddy("panda")).toBe("bean");
    expect(parseBuddy("penguin")).toBe("mushroom");
    expect(parseBuddy("bear")).toBe("peanut");
    expect(parseBuddy("rabbit")).toBe("plus");
    expect(parseBuddy("frog")).toBe("capsule");
    expect(parseBuddy("chick")).toBe("wedge");
  });

  it("writes the body alone when the color is its own", () => {
    expect(makeBuddy("gumdrop", "tangerine")).toBe("gumdrop");
    expect(makeBuddy("gumdrop", "jade")).toBe("gumdrop/jade");
  });
});
