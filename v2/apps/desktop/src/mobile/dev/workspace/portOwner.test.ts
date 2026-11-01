import { describe, expect, it } from "vitest";

import { FakeProcessRunner, type FakeRunHandler } from "../../FakeProcessRunner.js";
import type { HostOs } from "../../host.js";
import { metroOwner, type OwnerWorktree, owningWorktree } from "./portOwner.js";

const worktrees: OwnerWorktree[] = [
  { worktreeId: "checkout", path: "/repo/app", branch: "main" },
  { worktreeId: "wt-1", path: "/repo/app/.zli/worktrees/login", branch: "feat-login" },
  { worktreeId: "wt-2", path: "/repo/app/.zli/worktrees/cart", branch: "feat-cart" },
];

function check(handler: FakeRunHandler, os: HostOs = "linux", self = "wt-2") {
  const runner = new FakeProcessRunner(handler);
  return { runner, owner: metroOwner(8142, self, worktrees, { runner, os, env: { PATH: "/usr/bin" } }) };
}

/** lsof finds pid 4321 on the port, and reports its folder. */
const lsofWith =
  (folder: string): FakeRunHandler =>
  (command, args) => {
    if (command !== "lsof") return undefined;
    if (args.includes("-Fp")) return { stdout: "p4321\n" };
    return { stdout: `p4321\nfcwd\nn${folder}\n` };
  };

describe("Metro port owner", () => {
  it("names the worktree whose folder the listener runs from", async () => {
    const other = check(lsofWith("/repo/app/.zli/worktrees/login/apps/mobile"));
    expect(await other.owner).toEqual({ state: "other-worktree", pid: 4321, worktreeId: "wt-1", branch: "feat-login" });
    expect(other.runner.calls.map((call) => [call.command, ...call.args])).toEqual([
      ["lsof", "-nP", "-iTCP:8142", "-sTCP:LISTEN", "-Fp"],
      ["lsof", "-a", "-p", "4321", "-d", "cwd", "-Fn"],
    ]);
    expect(other.runner.calls[0]?.options).toMatchObject({ timeoutMs: 3_000, env: { PATH: "/usr/bin" } });

    expect(await check(lsofWith("/repo/app/.zli/worktrees/cart")).owner).toEqual({ state: "this-worktree", pid: 4321 });
    // The checkout holds the worktrees, so only a folder outside them is the checkout's.
    expect(await check(lsofWith("/repo/app/src")).owner).toMatchObject({
      state: "other-worktree",
      worktreeId: "checkout",
    });
    expect(await check(lsofWith("/home/person/elsewhere")).owner).toEqual({ state: "other-process", pid: 4321 });
    // A sibling folder that only shares a prefix is not inside the worktree.
    expect(await check(lsofWith("/repo/app/.zli/worktrees/cart-old")).owner).toMatchObject({
      worktreeId: "checkout",
    });
  });

  it("reports a free port when lsof finds no listener", async () => {
    expect(await check((command) => (command === "lsof" ? { code: 1 } : undefined)).owner).toEqual({ state: "free" });
  });

  it("reads the folder from /proc on Linux when lsof cannot", async () => {
    const { owner, runner } = check((command, args) => {
      if (command === "lsof") return args.includes("-Fp") ? { stdout: "p77\n" } : { code: 1 };
      if (command === "readlink") return { stdout: "/repo/app/.zli/worktrees/cart\n" };
      return undefined;
    });
    expect(await owner).toEqual({ state: "this-worktree", pid: 77 });
    expect(runner.argsOf("readlink")).toEqual([["/proc/77/cwd"]]);
  });

  it("falls back to ss on Linux without lsof", async () => {
    const missing = (command: string) => {
      if (command === "lsof") throw Object.assign(new Error("spawn lsof ENOENT"), { code: "ENOENT" });
    };
    const runner = new FakeProcessRunner();
    runner.run = async (command, args, options) => {
      missing(command);
      runner.calls.push({ command, args: [...args], options });
      if (command === "ss")
        return {
          code: 0,
          stdout: Buffer.from('LISTEN 0 511 *:8142 *:* users:(("node",pid=900,fd=23))\n'),
          stderr: "",
          timedOut: false,
        };
      return { code: 0, stdout: Buffer.from("/repo/app/.zli/worktrees/login\n"), stderr: "", timedOut: false };
    };
    const host = { runner, os: "linux" as const, env: {} };
    expect(await metroOwner(8142, "wt-2", worktrees, host)).toMatchObject({ state: "other-worktree", pid: 900 });
    expect(runner.argsOf("ss")).toEqual([["-ltnpH", "sport = :8142"]]);

    runner.run = async (command) => {
      missing(command);
      return { code: 0, stdout: Buffer.from(""), stderr: "", timedOut: false };
    };
    expect(await metroOwner(8142, "wt-2", worktrees, host)).toEqual({ state: "free" });
    // Another person's process shows no pid.
    runner.run = async (command) => {
      missing(command);
      return { code: 0, stdout: Buffer.from("LISTEN 0 511 *:8142 *:*\n"), stderr: "", timedOut: false };
    };
    expect(await metroOwner(8142, "wt-2", worktrees, host)).toEqual({ state: "other-process" });
    runner.run = async (command) => {
      missing(command);
      throw new Error("spawn ss ENOENT");
    };
    expect(await metroOwner(8142, "wt-2", worktrees, host)).toEqual({
      state: "unknown",
      reason: "Neither lsof nor ss is available, so the port was not checked.",
    });
  });

  it("gives up after the timeout, and does not check on Windows", async () => {
    expect(await check(() => ({ timedOut: true, code: null })).owner).toEqual({
      state: "unknown",
      reason: "The port check took too long.",
    });
    const windows = check(() => undefined, "windows");
    expect(await windows.owner).toEqual({ state: "unknown", reason: "Port owners are not checked on Windows yet." });
    expect(windows.runner.calls).toEqual([]);
  });

  it("says when it cannot read the listener's folder", async () => {
    const { owner } = check((command, args) => {
      if (command === "lsof") return args.includes("-Fp") ? { stdout: "p55\n" } : { code: 1 };
      return { code: 1 };
    });
    expect(await owner).toEqual({ state: "unknown", reason: "ZLI could not read the folder of process 55." });
  });

  it("matches macOS folders that lsof reports under /private", () => {
    const tmp = [{ worktreeId: "wt-9", path: "/var/folders/x/wt", branch: "b" }];
    expect(owningWorktree("/private/var/folders/x/wt/app", tmp, "macos")?.worktreeId).toBe("wt-9");
    expect(owningWorktree("/private/var/folders/x/wt/app", tmp, "linux")).toBeUndefined();
  });
});
