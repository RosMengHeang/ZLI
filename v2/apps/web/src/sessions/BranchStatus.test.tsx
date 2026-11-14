// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BranchStatus } from "./BranchStatus.js";
import type { BranchRead } from "./projectBranch.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const roots: Root[] = [];

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});

async function show(read: BranchRead | undefined, onRetry?: () => void) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<BranchStatus read={read} {...(onRetry ? { onRetry } : {})} />);
  });
  return container;
}

describe("BranchStatus", () => {
  it("tells reading, failed, detached, no Git, and a branch apart", async () => {
    expect((await show(undefined)).textContent).toBe("");
    expect((await show({ status: "loading" })).textContent).toBe("Reading branch…");
    expect((await show({ status: "failed" })).textContent).toBe("Couldn't read the branch");
    expect((await show({ status: "done", result: { git: true, detachedAt: "abc1234" } })).textContent).toBe(
      "Detachedabc1234",
    );
    expect((await show({ status: "done", result: { git: false } })).textContent).toBe("Not a Git repository");
    expect((await show({ status: "done", result: { git: true, branch: "main" } })).textContent).toBe("main");
  });

  it("offers Retry after a failed read when the caller can read again", async () => {
    const onRetry = vi.fn();
    const container = await show({ status: "failed" }, onRetry);
    await act(async () => {
      container.querySelector<HTMLButtonElement>("button")?.click();
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
