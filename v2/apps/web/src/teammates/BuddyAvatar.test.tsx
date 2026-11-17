// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { updateAppSettings } from "../settings/appSettings.js";
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
  updateAppSettings((current) => ({ ...current, animateTeammates: true }));
});

describe("BuddyAvatar", () => {
  it("says who it is and what it is doing", () => {
    const page = show(<BuddyAvatar buddy="sky" mood="waiting" name="Tester" size={22} />);
    const avatar = page.querySelector('[role="img"]');
    expect(avatar?.getAttribute("aria-label")).toBe("Tester, needs you");
    expect(avatar?.getAttribute("title")).toBe("Tester, needs you");
    expect(page.querySelector(".buddy-avatar-flag")).not.toBeNull();
  });

  it("is decoration without a name", () => {
    const page = show(<BuddyAvatar buddy="sky" size={22} />);
    expect(page.querySelector(".buddy-avatar")?.getAttribute("aria-hidden")).toBe("true");
    expect(page.querySelector('[role="img"]')).toBeNull();
  });

  it("flags a finished turn green and a failed one red", () => {
    const page = show(<BuddyAvatar buddy="sky" mood="done" size={22} />);
    expect(page.querySelector(".buddy-avatar-flag.is-done")).not.toBeNull();
    show(<BuddyAvatar buddy="sky" mood="failed" size={22} />);
    expect(page.querySelector(".buddy-avatar-flag.is-failed")).not.toBeNull();
  });

  it("only lets a resting buddy move around where it is large", () => {
    const page = show(<BuddyAvatar buddy="tangerine" size={22} />);
    expect(page.querySelector(".buddy-avatar")?.classList.contains("is-large")).toBe(false);
    show(<BuddyAvatar buddy="tangerine" size={44} />);
    expect(page.querySelector(".buddy-avatar")?.classList.contains("is-large")).toBe(true);
  });

  it("still shows the mood with motion off", () => {
    updateAppSettings((current) => ({ ...current, animateTeammates: false }));
    const page = show(<BuddyAvatar buddy="sky" mood="waiting" size={22} />);
    expect(page.querySelector(".buddy-avatar")?.classList.contains("is-still")).toBe(true);
    expect(page.querySelector(".buddy-avatar-flag")).not.toBeNull();
    // Waiting eyes are three pixels tall, six in all.
    expect(page.querySelectorAll(".buddy-eyes rect")).toHaveLength(6);
  });

  it("draws for notifications with its colors inline", () => {
    const svg = buddySvg("jade");
    expect(svg).toContain('fill="#2fbf8f"');
    expect(svg).toContain('width="96"');
  });
});
