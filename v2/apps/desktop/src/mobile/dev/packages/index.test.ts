import { describe, expect, it } from "vitest";

import type { MobileDevActionContext } from "../../MobileControlActions.js";
import { fixtureFiles } from "../doctor/testFixtures.js";
import { createTestDevHost } from "../testHost.js";
import { createPackages } from "./index.js";
import { checkUrl, directoryFetch } from "./testDirectory.js";

const answers = {
  [checkUrl("react-native-reanimated", "react-native-fs")]: {
    body: {
      "react-native-reanimated": { newArchitecture: "supported" },
      "react-native-fs": { newArchitecture: "untested", unmaintained: true },
    },
  },
  [checkUrl("react-native-fs")]: { body: { "react-native-fs": { newArchitecture: "untested", unmaintained: true } } },
};

function setup(fixture = "expo56-devclient") {
  const { fetch } = directoryFetch(answers);
  const host = createTestDevHost({ files: fixtureFiles(fixture), fetch });
  return { host, packages: createPackages(host) };
}

const context = {
  worktreeFor: () => ({ worktreeId: "wt-1", path: "/repo/app", status: "ready" }),
} as unknown as MobileDevActionContext;

describe("the package guard feature", () => {
  it("checks packages against the project's New Architecture setting and returns the install command", async () => {
    const { packages } = setup();
    const result = (await packages.ipc["zli:mobile:packages:check"]?.({
      worktreeId: "wt-1",
      packages: ["react-native-reanimated", "react-native-fs"],
    })) as { verdicts: { name: string; verdict: string }[]; command?: string };
    expect(result.verdicts.map((verdict) => [verdict.name, verdict.verdict])).toEqual([
      ["react-native-reanimated", "ok"],
      ["react-native-fs", "block"],
    ]);
    expect(result.command).toBe("npx expo install react-native-reanimated");
  });

  it("answers agents through mobilecheckpackage, with no install command when every package is blocked", async () => {
    const { packages } = setup("expo55-newarch-off");
    const result = await packages.actions.mobilecheckpackage?.(
      { cwd: "/repo/app", packages: ["react-native-fs"] },
      context,
    );
    expect(result).toEqual({
      verdicts: [
        {
          name: "react-native-fs",
          verdict: "block",
          reasons: [
            "It is not tested with the New Architecture, which this project uses.",
            "React Native Directory marks it unmaintained. Look for a maintained alternative.",
          ],
          newArchitecture: "untested",
          unmaintained: true,
        },
      ],
    });
  });

  it("refuses names that are not npm packages", async () => {
    const { packages } = setup();
    expect(() => packages.ipc["zli:mobile:packages:check"]?.({ worktreeId: "wt-1", packages: ["rm -rf /"] })).toThrow();
    await expect(packages.actions.mobilecheckpackage?.({ cwd: "/repo/app", packages: [] }, context)).rejects.toThrow();
  });

  it("proposes the install without blocked packages, once, and runs nothing", async () => {
    const { host, packages } = setup();
    const input = { worktreeId: "wt-1", packages: ["react-native-reanimated", "react-native-fs"] };
    const first = await packages.ipc["zli:mobile:packages:propose-install"]?.(input);
    expect(first).toMatchObject({
      state: "pending",
      source: "zli",
      sourceLabel: "From the project check",
      title: "Install react-native-reanimated",
      action: { kind: "command", program: "npx", args: ["expo", "install", "react-native-reanimated"], cwd: "." },
    });
    expect((first as { reason: string }).reason).toContain("Left out because they were blocked: react-native-fs.");
    expect(await packages.ipc["zli:mobile:packages:propose-install"]?.(input)).toEqual(first);
    expect(host.proposals.list("wt-1")).toHaveLength(1);
    expect(host.runner).toMatchObject({
      calls: expect.not.arrayContaining([expect.objectContaining({ command: "npx" })]),
    });
  });

  it("refuses to propose when every package was blocked", async () => {
    const { host, packages } = setup();
    await expect(
      packages.ipc["zli:mobile:packages:propose-install"]?.({ worktreeId: "wt-1", packages: ["react-native-fs"] }),
    ).rejects.toThrow("Every package was blocked");
    expect(host.proposals.list("wt-1")).toHaveLength(0);
  });

  it("answers 404 for a worktree ZLI does not know", async () => {
    const { packages } = setup();
    await expect(
      packages.ipc["zli:mobile:packages:check"]?.({ worktreeId: "wt-9", packages: ["react-native-fs"] }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
