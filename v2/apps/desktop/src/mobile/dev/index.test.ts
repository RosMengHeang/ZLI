import { describe, expect, it } from "vitest";

import { emptyMobileDevFeature } from "./host.js";
import { composeMobileDev, createMobileDev } from "./index.js";
import { createTestDevHost } from "./testHost.js";

describe("mobile dev composition", () => {
  it("joins the features, with proposals and every placeholder in place", () => {
    const dev = createMobileDev(createTestDevHost());
    expect(Object.keys(dev.actions)).toContain("mobilepropose");
    expect(Object.keys(dev.ipc)).toEqual(
      expect.arrayContaining([
        "zli:mobile:proposals:list",
        "zli:mobile:proposals:accept",
        "zli:mobile:proposals:dismiss",
      ]),
    );
    expect(Object.keys(dev.testOps)).toEqual(expect.arrayContaining(["propose", "propose-file"]));
    void dev.dispose();
  });

  it("refuses two features that claim the same action or channel", () => {
    const handler = async () => ({});
    const one = { ...emptyMobileDevFeature(), actions: { mobiledoctor: handler } };
    expect(() => composeMobileDev([one, one])).toThrow(/mobiledoctor/u);
    const channel = { ...emptyMobileDevFeature(), ipc: { "zli:mobile:doctor:check": () => ({}) } };
    expect(() => composeMobileDev([channel, channel])).toThrow(/zli:mobile:doctor:check/u);
  });

  it("chains every feature's decorate in order and disposes each feature even when one fails", async () => {
    const disposed: string[] = [];
    const dev = composeMobileDev([
      {
        ...emptyMobileDevFeature(),
        decorate: (_owner, _action, result) => ({ ...(result as object), a: 1 }),
        dispose: () => {
          throw new Error("stuck");
        },
      },
      {
        ...emptyMobileDevFeature(),
        decorate: (_owner, _action, result) => ({ ...(result as object), b: 2 }),
        dispose: () => {
          disposed.push("second");
        },
      },
    ]);
    const owner = { ownerId: "agent:wt-1", ownerLabel: "The agent in app", kind: "agent" } as const;
    expect(dev.decorate?.(owner, "mobiletap", { tapped: true })).toEqual({ tapped: true, a: 1, b: 2 });
    await dev.dispose();
    expect(disposed).toEqual(["second"]);
  });

  it("creates proposals from the e2e operations in the first ready worktree", async () => {
    const host = createTestDevHost({ files: { "/repo/app/AGENTS.md": "# Notes\n" } });
    const dev = createMobileDev(host);
    expect(dev.testOps.propose?.({ program: "npm", args: ["--version"] })).toMatchObject({
      worktreeId: "wt-1",
      sourceLabel: "Proposed by the agent in app",
      title: "Run a command",
      action: { kind: "command", program: "npm", args: ["--version"], cwd: "." },
    });
    const block = (await dev.testOps["propose-file"]?.({ content: "Use port 8082." })) as { proposalId: string };
    await host.proposals.accept(block.proposalId);
    expect(host.files.get("/repo/app/AGENTS.md")).toContain("Use port 8082.");
  });
});
