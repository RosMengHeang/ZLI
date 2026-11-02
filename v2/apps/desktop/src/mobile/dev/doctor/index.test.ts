import { describe, expect, it } from "vitest";

import type { MobileDevActionContext } from "../../MobileControlActions.js";
import { createMobileDev } from "../index.js";
import { createTestDevHost } from "../testHost.js";
import { createDoctor } from "./index.js";
import { fixtureFiles } from "./testFixtures.js";

const context = {
  worktreeFor: () => ({ worktreeId: "wt-1", path: "/repo/app", status: "ready" }),
} as unknown as MobileDevActionContext;

function setup(fixture = "expo55-newarch-off") {
  const host = createTestDevHost({ files: fixtureFiles(fixture) });
  return { host, doctor: createDoctor(host) };
}

describe("the mobile doctor feature", () => {
  it("joins the Mobile dev features with its action and channels", () => {
    const dev = createMobileDev(createTestDevHost());
    expect(Object.keys(dev.actions)).toEqual(expect.arrayContaining(["mobiledoctor", "mobilecheckpackage"]));
    expect(Object.keys(dev.ipc)).toEqual(
      expect.arrayContaining([
        "zli:mobile:doctor:check",
        "zli:mobile:doctor:deep-plan",
        "zli:mobile:doctor:deep-run",
        "zli:mobile:doctor:propose-block",
        "zli:mobile:doctor:propose-fix",
        "zli:mobile:packages:check",
        "zli:mobile:packages:propose-install",
      ]),
    );
  });

  it("answers the Toolchain group and agents with the same facts", async () => {
    const { doctor } = setup();
    const checked = await doctor.ipc["zli:mobile:doctor:check"]?.({ worktreeId: "wt-1" });
    expect(checked).toMatchObject({
      stack: "expo",
      versions: { expo: "55.0.4", "react-native": "0.83.1" },
      // SDK 55 ignores newArchEnabled: false, so the New Architecture is on whatever app.json says.
      newArch: { enabled: true, disabledIn: expect.arrayContaining(["app.json"]) },
      findings: expect.arrayContaining([expect.objectContaining({ id: "newarch-optout-removed", severity: "error" })]),
    });
    expect(await doctor.actions.mobiledoctor?.({ cwd: "/repo/app", refresh: true }, context)).toEqual(checked);
  });

  it("refuses a worktree ZLI does not know", async () => {
    const { doctor } = setup();
    await expect(doctor.ipc["zli:mobile:doctor:check"]?.({ worktreeId: "wt-9" })).rejects.toThrow("not in ZLI");
    const missing = {
      worktreeFor: () => ({ worktreeId: "wt-9", path: "/elsewhere", status: "ready" }),
    } as unknown as MobileDevActionContext;
    await expect(doctor.actions.mobiledoctor?.({ cwd: "/elsewhere" }, missing)).rejects.toMatchObject({ status: 404 });
  });

  it("proposes a finding's fix once and runs nothing", async () => {
    const { host, doctor } = setup("monorepo-apps-mobile");
    const input = { worktreeId: "wt-1", findingId: "expo-go-sdk55" };
    const proposal = await doctor.ipc["zli:mobile:doctor:propose-fix"]?.(input);
    expect(proposal).toMatchObject({
      state: "pending",
      source: "zli",
      sourceLabel: "From the project check",
      title: "Add expo-dev-client",
      action: { kind: "command", program: "npx", args: ["expo", "install", "expo-dev-client"], cwd: "apps/mobile" },
    });
    expect(await doctor.ipc["zli:mobile:doctor:propose-fix"]?.(input)).toEqual(proposal);
    expect(host.proposals.list("wt-1")).toHaveLength(1);
    expect(host.runner.calls.map((call) => call.command)).not.toContain("npx");
  });

  it("refuses a fix for a finding that is gone or has no command", async () => {
    const { doctor } = setup();
    await expect(
      doctor.ipc["zli:mobile:doctor:propose-fix"]?.({ worktreeId: "wt-1", findingId: "pods-drift" }),
    ).rejects.toThrow("no longer finds");
    await expect(
      doctor.ipc["zli:mobile:doctor:propose-fix"]?.({ worktreeId: "wt-1", findingId: "newarch-optout-removed" }),
    ).rejects.toThrow("no command");
  });

  it("proposes the notes block through IPC", async () => {
    const { host, doctor } = setup();
    expect(await doctor.ipc["zli:mobile:doctor:propose-block"]?.({ worktreeId: "wt-1" })).toMatchObject({
      upToDate: false,
      file: "AGENTS.md",
    });
    expect(host.proposals.list("wt-1")[0]?.action).toMatchObject({ kind: "file-block", file: "AGENTS.md" });
  });

  it("plans the Expo checks without running them", async () => {
    const { host, doctor } = setup();
    expect(await doctor.ipc["zli:mobile:doctor:deep-plan"]?.({ worktreeId: "wt-1" })).toMatchObject({ folder: "." });
    expect(host.runner.calls).toHaveLength(0);
  });
});
