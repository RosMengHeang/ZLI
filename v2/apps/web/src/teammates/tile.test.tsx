// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { BuddyAvatar, TileArt } from "./BuddyAvatar.js";
import { BUDDY_LOOKS, defaultLook, lookOf } from "./pixelBuddies.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

function show(node: React.ReactNode): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  act(() => {
    root = createRoot(host);
    root.render(node);
  });
  return host;
}

describe("buddy tiles", () => {
  it("always draws the face tile, at every size", () => {
    for (const size of [22, 44, 92]) {
      const host = show(<BuddyAvatar buddy="sky" size={size} />);
      expect(host.querySelector(".is-tile")).not.toBeNull();
      expect(host.querySelector(".buddy-foot")).toBeNull();
      act(() => root?.unmount());
    }
  });

  it("draws each body in pixels, in the buddy's color, with two bar eyes", () => {
    for (const look of BUDDY_LOOKS) {
      const svg = renderToStaticMarkup(<TileArt buddy="sky" look={look} size={32} />);
      expect(svg, look).toContain('fill="#4aa8ff"');
      expect(svg, look).toContain('shape-rendering="crispEdges"');
    }
    const host = show(<BuddyAvatar buddy="sky" look="critter" size={32} />);
    // Idle eyes: two bars, two pixels each.
    expect(host.querySelectorAll(".buddy-eyes rect")).toHaveLength(4);
  });

  it("gives a buddy from before bodies the same body every time, spread across the team", () => {
    expect(defaultLook("b1")).toBe(defaultLook("b1"));
    const looks = new Set(["a", "b", "c", "d", "e", "f", "g", "h"].map((id) => defaultLook(id)));
    expect(looks.size).toBeGreaterThan(2);
    expect(lookOf({ buddyId: "b1", look: "ghost" })).toBe("ghost");
  });
});
