// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { BuddyAvatar } from "./BuddyAvatar.js";

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
  it("shows a face tile in lists and the whole buddy where it is large", () => {
    expect(show(<BuddyAvatar buddy="cloud" size={22} />).querySelector(".is-tile")).not.toBeNull();
    act(() => root?.unmount());
    expect(show(<BuddyAvatar buddy="cloud" size={92} />).querySelector(".is-tile")).toBeNull();
  });

  it("draws the whole buddy when asked, as the picker does", () => {
    const host = show(<BuddyAvatar buddy="cloud" size={30} full />);
    expect(host.querySelector(".is-tile")).toBeNull();
    expect(host.querySelector(".buddy-foot")).not.toBeNull();
  });
});
