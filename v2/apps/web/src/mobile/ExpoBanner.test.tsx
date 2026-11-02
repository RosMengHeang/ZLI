// @vitest-environment jsdom

import type { MobileDevice } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fakeWorkspace, workspace } from "./dev/workspace/fakeWorkspace.js";
import { ExpoBanner } from "./ExpoBanner.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const device: MobileDevice = {
  deviceId: "android-avd:Pixel_8",
  platform: "android",
  kind: "emulator",
  name: "Pixel 8",
  state: "online",
  serial: "emulator-5554",
  lease: null,
};

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  window.sessionStorage.clear();
});

async function render(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(node));
  return container;
}

function props(api: ReturnType<typeof fakeWorkspace>["api"] | undefined, port: number) {
  return {
    mobile: {
      openUrl: vi.fn(async () => ({ reversedPort: port })),
      dev: { proposals: {}, ...(api ? { workspace: api } : {}) },
    } as never,
    worktreeId: "wt-1",
    device,
    server: { port, url: `http://localhost:${port}/` },
    inputBlocked: false,
    onBlockedInput: vi.fn(),
    onError: vi.fn(),
    onNotice: vi.fn(),
  };
}

describe("Expo banner", () => {
  it("opens this worktree's own URL through the workspace when Metro is on its port", async () => {
    const { api } = fakeWorkspace(workspace);
    const shown = props(api, 8142);
    const container = await render(<ExpoBanner {...shown} />);
    expect(container.querySelector(".banner-message")?.textContent).toBe(
      "Metro for this worktree is on localhost:8142.",
    );
    await act(async () => container.querySelector<HTMLButtonElement>(".btn-primary, button")?.click());
    expect(api.open).toHaveBeenCalledWith("wt-1", device.deviceId);
    expect((shown.mobile as { openUrl: unknown }).openUrl).not.toHaveBeenCalled();
    expect(shown.onNotice).toHaveBeenCalledWith(`Opened ${workspace.openUrl}. Forwarded localhost:8142 to the device.`);
  });

  it("turns Open off while another worktree serves the port", async () => {
    const { api } = fakeWorkspace({
      ...workspace,
      metro: { state: "other-worktree", pid: 2, worktreeId: "wt-2", branch: "feat-login" },
    });
    const container = await render(<ExpoBanner {...props(api, 8142)} />);
    const open = [...container.querySelectorAll("button")].find((entry) => entry.textContent === "Open on Pixel 8");
    expect(open?.disabled).toBe(true);
    expect(open?.getAttribute("data-tooltip")).toBe("Port 8142 belongs to feat-login");
  });

  it("waits for the owner check before opening a worktree-band port", async () => {
    let answer: ((found: typeof workspace) => void) | undefined;
    const api = {
      get: vi.fn(() => new Promise<typeof workspace>((resolve) => (answer = resolve))),
      list: vi.fn(),
      open: vi.fn(),
      onChange: () => () => undefined,
    };
    const shown = props(api as never, 8142);
    const container = await render(<ExpoBanner {...shown} />);
    const openButton = () =>
      [...container.querySelectorAll("button")].find((entry) => entry.textContent === "Open on Pixel 8");
    expect(container.querySelector(".banner-message")?.textContent).toBe("Expo is running on localhost:8142.");
    expect(openButton()?.disabled).toBe(true);
    expect(openButton()?.getAttribute("data-tooltip")).toBe("Checking who serves port 8142");
    await act(async () => answer?.(workspace));
    expect(container.querySelector(".banner-message")?.textContent).toBe(
      "Metro for this worktree is on localhost:8142.",
    );
    expect(openButton()?.disabled).toBe(false);
  });

  it("keeps Open off when the owner check fails, and while another program serves the port", async () => {
    const failing = {
      get: vi.fn(async (): Promise<typeof workspace> => {
        throw new Error("Error invoking remote method 'zli:mobile:workspace:get': Error: The check failed.");
      }),
      list: vi.fn(),
      open: vi.fn(),
      onChange: () => () => undefined,
    };
    const container = await render(<ExpoBanner {...props(failing as never, 8142)} />);
    const open = [...container.querySelectorAll("button")].find((entry) => entry.textContent === "Open on Pixel 8");
    expect(open?.disabled).toBe(true);
    expect(open?.getAttribute("data-tooltip")).toBe("The check failed.");
    act(() => root?.unmount());

    const { api } = fakeWorkspace({ ...workspace, metro: { state: "other-process", pid: 9 } });
    const next = await render(<ExpoBanner {...props(api, 8142)} />);
    expect(next.querySelector(".banner-message")?.textContent).toBe(
      "This worktree's Metro port 8142 is served from another program.",
    );
    const other = [...next.querySelectorAll("button")].find((entry) => entry.textContent === "Open on Pixel 8");
    expect(other?.disabled).toBe(true);
    expect(other?.getAttribute("data-tooltip")).toBe("Port 8142 belongs to another program");
  });

  it("keeps the plain Expo banner for other ports and without the workspace bridge", async () => {
    const { api } = fakeWorkspace(workspace);
    const other = props(api, 8081);
    const container = await render(<ExpoBanner {...other} />);
    expect(container.querySelector(".banner-message")?.textContent).toBe("Expo is running on localhost:8081.");
    const open = [...container.querySelectorAll("button")].find((entry) => entry.textContent === "Open on Pixel 8");
    await act(async () => open?.click());
    expect((other.mobile as { openUrl: unknown }).openUrl).toHaveBeenCalledWith(
      device.deviceId,
      "exp://localhost:8081",
    );
    expect(api.open).not.toHaveBeenCalled();
    act(() => root?.unmount());

    const bare = await render(<ExpoBanner {...props(undefined, 8142)} />);
    expect(bare.querySelector(".banner-message")?.textContent).toBe("Expo is running on localhost:8142.");
  });
});
