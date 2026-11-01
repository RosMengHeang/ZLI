// @vitest-environment jsdom

import type { MobileWorkspace } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MobileBridge } from "../../../runtime/bridge.js";
import type { MobileDevContext } from "../context.js";
import type { WorkspaceApi } from "./bridge.js";
import { fakeWorkspace, workspace } from "./fakeWorkspace.js";
import { WorkspaceBanner } from "./WorkspaceBanner.js";
import { WorkspaceProjectGroup } from "./WorkspaceProjectGroup.js";

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

function contextFor(api: WorkspaceApi | undefined, extra: Partial<MobileDevContext> = {}): MobileDevContext {
  return {
    mobile: { dev: { proposals: {}, ...(api ? { workspace: api } : {}) } } as unknown as MobileBridge,
    worktreeId: "wt-1",
    device: undefined,
    online: false,
    agentHolds: false,
    devServers: [],
    onError: vi.fn(),
    onNotice: vi.fn(),
    ...extra,
  };
}

describe("workspace banner", () => {
  it("warns only while another worktree or another program holds this worktree's port", async () => {
    const { api, change } = fakeWorkspace(workspace);
    const container = await render(<WorkspaceBanner context={contextFor(api)} />);
    expect(container.textContent).toBe("");

    await change({
      ...workspace,
      metro: { state: "other-worktree", pid: 9, worktreeId: "wt-2", branch: "feat-login" },
    });
    const banner = container.querySelector(".banner");
    expect(banner?.className).toBe("banner banner-warning");
    expect(banner?.textContent).toBe(
      "Port 8142 is served from feat-login, not this worktree. Opening it would show that branch's app.",
    );
    expect(banner?.querySelector("button")).toBeNull();

    await change({ ...workspace, metro: { state: "other-process", pid: 3 } }, { worktreeId: "wt-1" });
    expect(container.textContent).toBe("Another program is using port 8142, this worktree's Metro port.");

    // Another worktree's change does not reload this one.
    await change({ ...workspace, metro: { state: "this-worktree", pid: 3 } }, { worktreeId: "wt-2" });
    expect(container.textContent).toContain("Another program");
    await change({ ...workspace, metro: { state: "this-worktree", pid: 3 } }, { worktreeId: "wt-1" });
    expect(container.textContent).toBe("");
  });

  it("shows nothing without a worktree or the workspace bridge", async () => {
    const { api } = fakeWorkspace(workspace);
    const container = await render(<WorkspaceBanner context={contextFor(api, { worktreeId: undefined })} />);
    expect(container.textContent).toBe("");
    expect(api.get).not.toHaveBeenCalled();
    act(() => root?.unmount());
    expect((await render(<WorkspaceBanner context={contextFor(undefined)} />)).textContent).toBe("");
  });
});

describe("this worktree group", () => {
  it("shows the port with its owner, the URL to open with Copy URL, and the emulator port", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { api, change } = fakeWorkspace({ ...workspace, metro: { state: "this-worktree", pid: 4 } });
    const context = contextFor(api);
    const container = await render(<WorkspaceProjectGroup context={context} />);
    expect(container.querySelector("h4")?.textContent).toBe("This worktree");
    const rows = [...container.querySelectorAll(".setting-row")].map((row) => row.textContent);
    expect(rows).toEqual([
      "Metro portSet as RCT_METRO_PORT in this worktree's terminals.8142Running here",
      `Open on a deviceDevelopment build${workspace.openUrl}`,
      "Emulator portemulator-5560",
    ]);
    expect(container.querySelector(".badge")?.className).toContain("badge-success");
    const copy = container.querySelector<HTMLButtonElement>('button[aria-label="Copy URL"]');
    await act(async () => copy?.click());
    expect(writeText).toHaveBeenCalledWith(workspace.openUrl);
    expect(context.onNotice).toHaveBeenCalledWith("Copied the URL.");

    const badges = async (metro: MobileWorkspace["metro"]) => {
      await change({ ...workspace, metro });
      const badge = container.querySelector(".badge");
      return [badge?.textContent, badge?.className.replace("badge ", "")];
    };
    expect(await badges({ state: "free" })).toEqual(["Free", "badge-neutral"]);
    expect(await badges({ state: "other-worktree", pid: 1, worktreeId: "wt-2", branch: "feat-login" })).toEqual([
      "Used by feat-login",
      "badge-warning",
    ]);
    expect(await badges({ state: "other-process" })).toEqual(["Used by another program", "badge-warning"]);
    expect(await badges({ state: "unknown", reason: "No lsof." })).toEqual(["Not checked", "badge-quiet"]);

    await change({
      ...workspace,
      checkout: true,
      metroPort: 8081,
      devClient: false,
      openUrl: "exp://localhost:8081",
      emulatorPort: undefined,
    } as MobileWorkspace);
    const text = container.textContent ?? "";
    expect(text).toContain("The project's own checkout keeps Metro's default port.");
    expect(text).toContain("Expo Goexp://localhost:8081");
    expect(text).toContain("Any free port");
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("shows why the worktree could not be read", async () => {
    const { api } = fakeWorkspace([]);
    const container = await render(<WorkspaceProjectGroup context={contextFor(api)} />);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("ZLI does not know the worktree wt-1.");
  });
});
