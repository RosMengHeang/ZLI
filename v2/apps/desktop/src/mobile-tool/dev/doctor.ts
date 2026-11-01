import { MobileProjectFacts as Facts, type MobileProjectFacts, proposalCommandLine } from "@zli-v2/contracts";

import type { MobileDevToolModule } from "./types.js";

const VERSION_LABELS: Readonly<Record<string, string>> = {
  expo: "Expo SDK package (expo)",
  "react-native": "React Native",
  react: "React",
  gradle: "Gradle",
  agp: "Android Gradle Plugin",
  kotlin: "Kotlin",
  flutter: "Flutter",
  dart: "Dart",
};

const HOST_LABELS: Readonly<Record<string, string>> = {
  node: "Node.js",
  java: "Java",
  adb: "adb",
  xcode: "Xcode",
  cocoapods: "CocoaPods",
};

export const doctorTools: MobileDevToolModule = {
  tools: [
    {
      name: "mobile_doctor",
      title: "Check the mobile project",
      action: "mobiledoctor",
      readOnly: true,
      description:
        "The app's real versions (Expo SDK, React Native, Gradle, AGP, Kotlin, Java, Xcode, CocoaPods), whether it runs in Expo Go or a development build, signing setup, and known problems with fixes. Read this before changing versions or native config; your training data may be older than this project.",
      properties: {
        refresh: {
          type: "boolean",
          description: "Probe this computer's tools again instead of using the last minute's answers.",
        },
      },
    },
  ],
  format: (action, result) => {
    if (action !== "mobiledoctor") return undefined;
    const parsed = Facts.safeParse(result);
    return parsed.success ? { content: [{ type: "text", text: formatFacts(parsed.data) }] } : undefined;
  },
  instructions:
    "Before changing package versions, Gradle, Podfile, or native config in a mobile app, call mobile_doctor for the project's real versions and known problems.",
};

export function formatFacts(facts: MobileProjectFacts): string {
  if (facts.stack === "none")
    return "No mobile app found in this worktree. ZLI looks for Expo, React Native, Flutter, Android, and Xcode projects.";
  const lines: string[] = [];
  lines.push(`Stack: ${facts.stack}${facts.appDir === "." ? "" : `, in ${facts.appDir}`}.`);
  if (facts.client) lines.push(`Runs in: ${clientLabel(facts.client.kind)}. ${facts.client.reason}`);
  if (facts.newArch?.enabled !== undefined)
    lines.push(
      `New Architecture: ${facts.newArch.enabled ? "on" : "off"}${facts.newArch.source ? ` (${facts.newArch.source})` : ""}.`,
    );
  lines.push("Versions:");
  for (const [key, value] of Object.entries(facts.versions)) {
    if (key in HOST_LABELS) continue;
    lines.push(`- ${VERSION_LABELS[key] ?? key}: ${value}`);
  }
  for (const [key, value] of Object.entries(facts.host ?? {})) lines.push(`- ${HOST_LABELS[key] ?? key}: ${value}`);
  if (facts.appIds && Object.keys(facts.appIds).length > 0)
    lines.push(
      `App ids: ${Object.entries(facts.appIds)
        .map(([key, value]) => `${key} ${value}`)
        .join(", ")}.`,
    );
  if (facts.signing)
    lines.push(
      `Signing: Android ${facts.signing.android}; iOS ${
        facts.signing.ios === "not-checked"
          ? "not checked on this computer"
          : `${facts.signing.ios.identities} identities`
      }. Do not create or change certificates, profiles, or keystores; tell the person what is missing.`,
    );
  if (facts.findings.length === 0) lines.push("Known problems: none found.");
  else {
    lines.push("Known problems:");
    for (const finding of facts.findings) {
      let line = `- ${finding.severity}: ${finding.title}. ${finding.detail}`;
      if (finding.fix?.kind === "command")
        line += ` Fix: ${proposalCommandLine({ program: finding.fix.program, args: finding.fix.args })}${
          finding.fix.cwd === "." ? "" : ` in ${finding.fix.cwd}`
        }. Propose it with mobile_propose; do not run it yourself.`;
      if (finding.source) line += ` Source: ${finding.source}`;
      lines.push(line);
    }
  }
  const deep = facts.deep;
  if (deep) {
    const steps = [
      deep.expoConfig ? `expo config ${deep.expoConfig.state}` : undefined,
      deep.expoInstallCheck
        ? `expo install --check ${deep.expoInstallCheck.state}${deep.expoInstallCheck.packages.length > 0 ? ` (${deep.expoInstallCheck.packages.join(", ")})` : ""}`
        : undefined,
      deep.expoDoctor
        ? `expo-doctor ${deep.expoDoctor.state}${deep.expoDoctor.failures.length > 0 ? `: ${deep.expoDoctor.failures.join("; ")}` : ""}`
        : undefined,
    ].filter(Boolean);
    lines.push(`Expo checks from ${deep.ranAt}: ${steps.join(", ")}.`);
  } else if (facts.stack === "expo")
    lines.push(
      "Expo checks have not run. They run the project's code, so only the person can start them from the Mobile panel's Project check.",
    );
  if (facts.notes)
    lines.push(
      facts.notes.state === "current"
        ? `${facts.notes.file} has ZLI's current mobile notes.`
        : `${facts.notes.file} ${facts.notes.state === "missing" ? "has no" : "has outdated"} ZLI mobile notes. The person can add them from the Project check.`,
    );
  lines.push(`Toolchain fingerprint: ${facts.fingerprint}.`);
  return lines.join("\n");
}

function clientLabel(kind: NonNullable<MobileProjectFacts["client"]>["kind"]): string {
  switch (kind) {
    case "dev-build":
      return "a development build";
    case "expo-go":
      return "Expo Go";
    case "bare":
      return "a native build";
    default:
      return "unknown";
  }
}
