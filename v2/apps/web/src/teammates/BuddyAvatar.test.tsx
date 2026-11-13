// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { BuddyAvatar } from "./BuddyAvatar.js";
import { buddySvg } from "./buddyIcon.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;

function show(node: ReactNode): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  act(() => {
    root ??= createRoot(host);
    root.render(node);
  });
  return document.body;
}

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

describe("BuddyAvatar", () => {
  it("says who it is and what it is doing", () => {
    const page = show(<BuddyAvatar buddy="cloud/jade" mood="waiting" name="Reviewer" size={22} />);
    const avatar = page.querySelector('[role="img"]');
    expect(avatar?.getAttribute("aria-label")).toBe("Reviewer, needs you");
    expect(avatar?.getAttribute("title")).toBe("Reviewer (Cloud), needs you");
  });

  it("only lets a resting buddy move around where it is large", () => {
    const page = show(<BuddyAvatar buddy="gumdrop" size={22} />);
    expect(page.querySelector(".buddy-avatar")?.classList.contains("is-large")).toBe(false);
    show(<BuddyAvatar buddy="gumdrop" size={44} />);
    expect(page.querySelector(".buddy-avatar")?.classList.contains("is-large")).toBe(true);
  });

  it("drops cheeks at list size and keeps them when large", () => {
    const page = show(<BuddyAvatar buddy="gumdrop" size={22} />);
    expect(page.querySelectorAll(".buddy-cheek")).toHaveLength(0);
    show(<BuddyAvatar buddy="gumdrop" size={56} />);
    expect(page.querySelectorAll(".buddy-cheek")).toHaveLength(2);
  });

  it("draws for notifications with its colors inline", () => {
    const svg = buddySvg("cloud/jade");
    expect(svg).toContain('fill="#2fbf8f"');
    expect(svg).toContain('width="96"');
  });
});
