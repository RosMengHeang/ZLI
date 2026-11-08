import { describe, expect, it } from "vitest";

import { packagesTools } from "./packages.js";

const text = (result: unknown) =>
  (packagesTools.format?.("mobilecheckpackage", result)?.content[0] as { text: string } | undefined)?.text;

describe("mobile_check_package", () => {
  it("lists each verdict and how to propose the install", () => {
    expect(
      text({
        verdicts: [
          { name: "react-native-reanimated", verdict: "ok", reasons: ["Supports the New Architecture."] },
          { name: "react-native-fs", verdict: "block", reasons: ["It is not tested with the New Architecture."] },
          { name: "left-pad", verdict: "unchecked", reasons: [] },
        ],
        install: {
          kind: "command",
          program: "npx",
          args: ["expo", "install", "react-native-reanimated"],
          cwd: "apps/mobile",
        },
        command: "npx expo install react-native-reanimated",
      }),
    ).toBe(
      [
        "- react-native-reanimated: fine. Supports the New Architecture.",
        "- react-native-fs: blocked. It is not tested with the New Architecture.",
        "- left-pad: not checked.",
        'Install with: npx expo install react-native-reanimated in apps/mobile. Propose it with mobile_propose (program npx, args ["expo","install","react-native-reanimated"], folder apps/mobile); do not run it yourself.',
      ].join("\n"),
    );
  });

  it("says when nothing is left to install", () => {
    expect(text({ verdicts: [{ name: "react-native-fs", verdict: "block", reasons: [] }] })).toContain(
      "Every package was blocked",
    );
  });

  it("formats only its own action and well-formed results", () => {
    expect(packagesTools.format?.("mobiledoctor", { verdicts: [] })).toBeUndefined();
    expect(packagesTools.format?.("mobilecheckpackage", { verdicts: "no" })).toBeUndefined();
    expect(packagesTools.tools[0]?.required).toEqual(["packages"]);
  });
});
