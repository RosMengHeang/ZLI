import { MobilePackageCheck } from "@zli-v2/contracts";

import type { MobileDevToolModule } from "./types.js";

const LABELS = { ok: "fine", warn: "warning", block: "blocked", unchecked: "not checked" } as const;

export const packagesTools: MobileDevToolModule = {
  tools: [
    {
      name: "mobile_check_package",
      title: "Check packages before installing",
      action: "mobilecheckpackage",
      readOnly: true,
      description:
        "Check npm packages against React Native Directory before adding them: New Architecture support, Expo Go support, config plugins, and whether they are maintained. Returns the install command that picks versions matching this project's SDK. Propose that command with mobile_propose instead of running npm install.",
      properties: {
        packages: {
          type: "array",
          items: { type: "string" },
          description:
            "Up to 20 npm package names, optionally with @version, such as react-native-mmkv or expo-camera.",
        },
      },
      required: ["packages"],
    },
  ],
  format: (action, result) => {
    if (action !== "mobilecheckpackage") return undefined;
    const parsed = MobilePackageCheck.safeParse(result);
    if (!parsed.success) return undefined;
    const lines = parsed.data.verdicts.map(
      (verdict) =>
        `- ${verdict.name}: ${LABELS[verdict.verdict]}.${verdict.reasons.length > 0 ? ` ${verdict.reasons.join(" ")}` : ""}`,
    );
    const install = parsed.data.install;
    if (install?.kind === "command")
      lines.push(
        `Install with: ${parsed.data.command}${install.cwd === "." ? "" : ` in ${install.cwd}`}. Propose it with mobile_propose (program ${install.program}, args ${JSON.stringify(install.args)}${install.cwd === "." ? "" : `, folder ${install.cwd}`}); do not run it yourself.`,
      );
    else if (parsed.data.verdicts.every((verdict) => verdict.verdict === "block"))
      lines.push("Every package was blocked, so there is nothing to install. Look for a supported alternative.");
    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
  instructions:
    "Before adding an npm package to a mobile app, call mobile_check_package and propose the install command it returns.",
};
