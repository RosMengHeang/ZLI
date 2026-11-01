import { readFileSync } from "node:fs";

import type { MobileBuildBrief, MobileProposal } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import { formatMobileResult } from "../../../mobile-tool/mcp.js";
import { createMobileControlActions } from "../../MobileControlActions.js";
import { createTestDevHost } from "../testHost.js";
import { createBuild } from "./index.js";
import type { LogFiles } from "./logPath.js";

const log = readFileSync(new URL("./fixtures/eas-pods-incompatible.log", import.meta.url), "utf8");

function setup(files?: LogFiles) {
  const host = createTestDevHost();
  const feature = createBuild(host, files ? { files } : {});
  const dispatch = createMobileControlActions({
    manager: () => undefined,
    worktrees: () => host.worktrees(),
    settings: async () => host.settingsValue,
    status: async () => ({}) as never,
    reveal: () => undefined,
    platform: "linux",
    dev: { actions: feature.actions },
  });
  return { host, feature, dispatch };
}

describe("build brief feature", () => {
  it("answers an agent's log without a device, and formats the brief as text", async () => {
    const { dispatch } = setup();
    const brief = (await dispatch("mobilebuildbrief", { cwd: "/repo/app", log })) as MobileBuildBrief;
    expect(brief.category).toBe("cocoapods");
    const formatted = formatMobileResult("mobilebuildbrief", brief);
    expect(formatted.content).toEqual([{ type: "text", text: brief.text }]);
    expect(brief.text).toContain("Propose: pod install --repo-update (mobile_propose)");
  });

  it("needs exactly one of log and logPath", async () => {
    const { dispatch } = setup();
    await expect(dispatch("mobilebuildbrief", { cwd: "/repo/app" })).rejects.toMatchObject({ status: 400 });
    await expect(dispatch("mobilebuildbrief", { cwd: "/repo/app", log, logPath: "a.log" })).rejects.toMatchObject({
      status: 400,
    });
  });

  it("reads logPath through the worktree guard", async () => {
    const files: LogFiles = {
      realpath: async (file) => file,
      stat: async () => ({ size: log.length, isFile: () => true }),
      readTail: async () => log,
      tmpdir: () => "/tmp",
      path: (await import("node:path")).posix,
    };
    const { dispatch } = setup(files);
    expect(
      ((await dispatch("mobilebuildbrief", { cwd: "/repo/app", logPath: "build.log" })) as MobileBuildBrief).stack,
    ).toBe("eas");
    await expect(dispatch("mobilebuildbrief", { cwd: "/repo/app", logPath: "/etc/passwd" })).rejects.toMatchObject({
      status: 400,
      message: "ZLI reads build logs only from this worktree or the temp folder.",
    });
  });

  it("explains a pasted log for the panel and proposes its command as a ZLI card", async () => {
    const { feature, host } = setup();
    const brief = (await feature.ipc["zli:mobile:build:brief"]?.({ worktreeId: "wt-1", log })) as MobileBuildBrief;
    const action = brief.suggestion?.action;
    expect(action?.kind).toBe("command");
    const proposal = (await feature.ipc["zli:mobile:build:propose"]?.({
      worktreeId: "wt-1",
      title: brief.suggestion?.title,
      reason: brief.suggestion?.text,
      action,
    })) as MobileProposal;
    expect(proposal).toMatchObject({
      source: "zli",
      sourceLabel: "From the build brief",
      title: "Install pods",
      state: "pending",
    });
    expect(host.commands).toEqual([]);
    expect(() => feature.ipc["zli:mobile:build:brief"]?.({ worktreeId: "nope", log })).toThrow(
      "That worktree is not in ZLI.",
    );
    expect(() =>
      feature.ipc["zli:mobile:build:propose"]?.({
        worktreeId: "wt-1",
        action: { kind: "command", program: "rm", args: ["-rf", "/"] },
      }),
    ).toThrow();
    expect(() =>
      feature.ipc["zli:mobile:build:propose"]?.({
        worktreeId: "wt-1",
        action: { kind: "file-block", file: "AGENTS.md", marker: "zli:mobile", content: "x", baseDigest: "absent" },
      }),
    ).toThrow("The build brief proposes commands only.");
  });
});
