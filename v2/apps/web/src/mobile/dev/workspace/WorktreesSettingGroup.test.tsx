// @vitest-environment jsdom

import type { MobileWorkspace } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

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
    const rows = [...container.querySelectorAll(".setting-row")];
    expect(rows.map((row) => row.textContent)).toEqual(["mainapp8081Free", "feat-cartcart8142Used by feat-login"]);
    expect(container.querySelector("section.mobile-worktrees .setting-label")).not.toBeNull();
    expect(rows[1]?.querySelector(".setting-description span")?.getAttribute("title")).toBe("/repo/wt/cart");

    await change([{ ...workspace, metro: { state: "this-worktree", pid: 5 } }]);
    expect([...container.querySelectorAll(".setting-row")].map((row) => row.textContent)).toEqual([
      "feat-cartcart8142Running here",
    ]);
    await change([]);
    expect(container.textContent).toContain("No worktrees yet.");
  });

  it("shows nothing without the workspace bridge", async () => {
    expect((await render(<WorktreesSettingGroup mobile={bridge(undefined)} />)).textContent).toBe("");
  });

  it("lets only the newest read land", async () => {
    const resolvers: Array<(list: MobileWorkspace[]) => void> = [];
    let notify: (() => void) | undefined;
    const api = {
      get: vi.fn(),
      open: vi.fn(),
      list: vi.fn(() => new Promise<MobileWorkspace[]>((resolve) => resolvers.push(resolve))),
      onChange: (listener: () => void) => {
        notify = listener;
        return () => undefined;
      },
    };
    const container = await render(<WorktreesSettingGroup mobile={bridge(api as never)} />);
    expect(container.textContent).toContain("Reading worktrees");
    await act(async () => notify?.());
    expect(api.list).toHaveBeenCalledTimes(2);
    await act(async () => resolvers[1]?.([{ ...workspace, branch: "new-branch" }]));
    expect(container.textContent).toContain("new-branch");
    await act(async () => resolvers[0]?.([{ ...workspace, branch: "old-branch" }]));
    expect(container.textContent).toContain("new-branch");
    expect(container.textContent).not.toContain("old-branch");
  });

  it("strips the IPC prefix from errors", async () => {
    const api = {
      get: vi.fn(),
      open: vi.fn(),
      list: vi.fn(async (): Promise<MobileWorkspace[]> => {
        throw new Error("Error invoking remote method 'zli:mobile:workspace:list': Error: The check failed.");
      }),
      onChange: () => () => undefined,
    };
    const container = await render(<WorktreesSettingGroup mobile={bridge(api as never)} />);
    expect(container.querySelector(".inline-error")?.textContent).toBe("The check failed.");
  });
});
