// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { BuddyAvatar, TileArt } from "./BuddyAvatar.js";

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

  it("is a rounded square in the buddy's color with two dark bar eyes", () => {
    const svg = renderToStaticMarkup(<TileArt buddy="sky" size={32} />);
    expect(svg).toContain('fill="#4aa8ff"');
    expect(svg.match(/<rect[^>]*fill="#16151a"/g)).toHaveLength(2);
  });
});
