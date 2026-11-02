import { emulatorPortFor, MobileWorkspace, metroPortFor } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import type { BrowserControlWorktree } from "../../../browser/BrowserControlActions.js";
import type { AndroidDriver } from "../../AndroidDriver.js";
import { DeviceManager } from "../../DeviceManager.js";
import { FakeDriver } from "../../FakeDriver.js";
import { FakeProcessRunner } from "../../FakeProcessRunner.js";
import type { MobileDevActionContext } from "../../MobileControlActions.js";
import { createMobileDev } from "../index.js";
import { createTestDevHost } from "../testHost.js";
import { createWorkspace, WORKSPACE_CHANGED } from "./index.js";

// The runtime passes full projections, which carry the branch and kind beside the fields the type names.
const worktrees = [
  { worktreeId: "checkout", path: "/repo/app", status: "ready", kind: "checkout", branch: "main" },
  { worktreeId: "wt-1", path: "/repo/wt/login", status: "ready", kind: "worktree", branch: "feat-login" },
  { worktreeId: "wt-2", path: "/repo/wt/cart", status: "ready", kind: "worktree", branch: "feat-cart" },
] as unknown as BrowserControlWorktree[];

const pixel = {
  deviceId: "android-avd:Pixel_7",
  platform: "android",
  kind: "emulator",
  name: "Pixel 7",
  state: "online",
  serial: "emulator-5554",
} as const;

function setup(runner = new FakeProcessRunner()) {
  const android = new FakeDriver("android", [pixel]);
  const manager = new DeviceManager({
    android: android as unknown as AndroidDriver,
    ios: new FakeDriver("ios", []),
    scrcpyServer: async () => "/zli/scrcpy-server",
  });
  const host = createTestDevHost({
    worktrees,
    runner,
    manager,
    files: {
      "/repo/wt/login/package.json": JSON.stringify({ dependencies: { expo: "54", "expo-dev-client": "6" } }),
      "/repo/wt/login/app.json": JSON.stringify({ expo: { scheme: "shop" } }),
    },
  });
  return { host, android, manager, feature: createWorkspace(host) };
}

describe("workspace feature", () => {
  it("gives the checkout Metro's 8081 and each worktree its own port and open URL", async () => {
    const { feature } = setup();
    const get = feature.ipc["zli:mobile:workspace:get"];
    const checkout = MobileWorkspace.parse(await get?.({ worktreeId: "checkout" }));
    expect(checkout).toEqual({
      worktreeId: "checkout",
      branch: "main",
      path: "/repo/app",
      checkout: true,
      metroPort: 8081,
      metro: { state: "free" },
      devClient: false,
      openUrl: "exp://localhost:8081",
    });
    const port = metroPortFor("wt-1", worktrees);
    expect(port).toBeGreaterThanOrEqual(8100);
    expect(port).toBeLessThan(8200);
    expect(await get?.({ worktreeId: "wt-1" })).toEqual({
      worktreeId: "wt-1",
      branch: "feat-login",
      path: "/repo/wt/login",
      metroPort: port,
      emulatorPort: emulatorPortFor("wt-1", worktrees),
      metro: { state: "free" },
      devClient: true,
      scheme: "shop",
      openUrl: `shop://expo-development-client/?url=http%3A%2F%2Flocalhost%3A${port}`,
    });
    await expect(Promise.resolve(get?.({ worktreeId: "wt-9" }))).rejects.toMatchObject({ status: 404 });
    expect(MobileWorkspace.array().parse(await feature.ipc["zli:mobile:workspace:list"]?.(undefined))).toHaveLength(3);
  });

  it("checks who listens on the port, and lets the e2e operation answer instead", async () => {
    const runner = new FakeProcessRunner((command, args) => {
      if (command !== "lsof") return undefined;
      return args.includes("-Fp") ? { stdout: "p31\n" } : { stdout: "n/repo/wt/cart\n" };
    });
    const { feature, host } = setup(runner);
    const get = (worktreeId: string) => feature.ipc["zli:mobile:workspace:get"]?.({ worktreeId });
    expect(await get("wt-1")).toMatchObject({
      metro: { state: "other-worktree", pid: 31, worktreeId: "wt-2", branch: "feat-cart" },
    });
    expect(await get("wt-2")).toMatchObject({ metro: { state: "this-worktree", pid: 31 } });

    const owner = { state: "other-process", pid: 7 } as const;
    expect(feature.testOps["metro-owner"]?.({ worktreeId: "wt-1", owner })).toEqual({ accepted: true });
    expect(await get("wt-1")).toMatchObject({ metro: owner });
    expect(await get("wt-2")).toMatchObject({ metro: { state: "this-worktree" } });
    feature.testOps["metro-owner"]?.({ owner: { state: "free" } });
    expect(await get("wt-2")).toMatchObject({ metro: { state: "free" } });
    expect(host.sent.filter((entry) => entry.channel === WORKSPACE_CHANGED).map((entry) => entry.payload)).toEqual([
      { worktreeId: "wt-1" },
      {},
    ]);
  });

  it("answers the agent's mobile_workspace call for its own worktree, with the device it holds", async () => {
    const { feature, manager } = setup();
    manager.acquireForAgent(pixel.deviceId, { ownerId: "agent:wt-2", ownerLabel: "The agent in cart", kind: "agent" });
    const context = { worktreeFor: () => worktrees[2] } as unknown as MobileDevActionContext;
    expect(await feature.actions.mobileworkspace?.({ cwd: "/repo/wt/cart" }, context)).toMatchObject({
      worktreeId: "wt-2",
      metroPort: metroPortFor("wt-2", worktrees),
      deviceId: pixel.deviceId,
    });
  });

  it("opens the worktree's own URL on the device, and refuses a port another worktree serves", async () => {
    const { feature, android } = setup();
    const open = feature.ipc["zli:mobile:workspace:open"];
    const port = metroPortFor("wt-2", worktrees);
    expect(await open?.({ worktreeId: "wt-2", deviceId: pixel.deviceId })).toEqual({
      opened: `exp://localhost:${port}`,
    });
    expect(android.actions).toEqual([`open ${pixel.deviceId} exp://localhost:${port}`]);
    await expect(Promise.resolve(open?.({ worktreeId: "wt-2", url: "x" }))).rejects.toThrow();

    feature.testOps["metro-owner"]?.({
      worktreeId: "wt-2",
      owner: { state: "other-worktree", pid: 9, worktreeId: "wt-1", branch: "feat-login" },
    });
    await expect(Promise.resolve(open?.({ worktreeId: "wt-2", deviceId: pixel.deviceId }))).rejects.toMatchObject({
      status: 409,
      message: `Port ${port} belongs to feat-login.`,
    });
  });

  it("joins the mobile dev features with its action, channels, and test operation", () => {
    const dev = createMobileDev(createTestDevHost({ worktrees }));
    expect(Object.keys(dev.actions)).toContain("mobileworkspace");
    expect(Object.keys(dev.ipc)).toEqual(
      expect.arrayContaining(["zli:mobile:workspace:get", "zli:mobile:workspace:list", "zli:mobile:workspace:open"]),
    );
    expect(Object.keys(dev.testOps)).toContain("metro-owner");
  });
});
