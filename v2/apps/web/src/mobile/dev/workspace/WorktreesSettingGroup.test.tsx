// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import type { MobileBridge } from "../../../runtime/bridge.js";
import { fakeWorkspace, workspace } from "./fakeWorkspace.js";
import { WorktreesSettingGroup } from "./WorktreesSettingGroup.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

async function render(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(node));
  return container;
}

const bridge = (api: ReturnType<typeof fakeWorkspace>["api"] | undefined) =>
  ({ dev: { proposals: {}, ...(api ? { workspace: api } : {}) } }) as unknown as MobileBridge;

describe("Worktrees setting group", () => {
  it("lists each worktree's branch, folder, port, and owner", async () => {
    const { api, change } = fakeWorkspace([
      { ...workspace, worktreeId: "checkout", branch: "main", path: "/repo/app", metroPort: 8081, checkout: true },
      { ...workspace, metro: { state: "other-worktree", pid: 1, worktreeId: "wt-2", branch: "feat-login" } },
    ]);
    const container = await render(<WorktreesSettingGroup mobile={bridge(api)} />);
    expect(container.querySelector("h4")?.textContent).toBe("Worktrees");
    expect(container.querySelector(".settings-group-note")?.textContent).toBe(
      "Each worktree gets its own Metro port so agents never test another branch's app.",
    );
    const rows = [...container.querySelectorAll(".mobile-worktree-row")];
    expect(rows.map((row) => row.textContent)).toEqual(["mainapp8081Free", "feat-cartcart8142Used by feat-login"]);
    expect(rows[1]?.querySelector(".setting-label")?.className).toContain("is-mono");
    expect(rows[1]?.querySelector(".setting-description")?.getAttribute("title")).toBe("/repo/wt/cart");

    await change([{ ...workspace, metro: { state: "this-worktree", pid: 5 } }]);
    expect([...container.querySelectorAll(".mobile-worktree-row")].map((row) => row.textContent)).toEqual([
      "feat-cartcart8142Running here",
    ]);
    await change([]);
    expect(container.textContent).toContain("No worktrees yet.");
  });

  it("shows nothing without the workspace bridge", async () => {
    expect((await render(<WorktreesSettingGroup mobile={bridge(undefined)} />)).textContent).toBe("");
  });
});
