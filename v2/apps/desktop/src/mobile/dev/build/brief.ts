import {
  BUILD_CATEGORY_LABELS,
  BUILD_STACK_LABELS,
  type MobileBuildBrief,
  type MobileBuildCategory,
  type MobileFinding,
  type MobileProjectFactsCore,
  MobileProposalAction,
  proposalCommandLine,
} from "@zli-v2/contracts";

import { projectFacts } from "../doctor/facts.js";
import type { MobileDevHost } from "../host.js";
import { type BuildClassification, classifyBuildLog } from "./classify.js";

const TEXT_MAX = 4_000;

const LIKELY_FILES: Record<MobileBuildCategory, readonly string[]> = {
  version: ["package.json", "app.json", "android/build.gradle", "android/gradle.properties"],
  "jdk-gradle": [
    "android/gradle/wrapper/gradle-wrapper.properties",
    "android/build.gradle",
    "android/gradle.properties",
  ],
  "native-module": ["package.json", "android/settings.gradle", "android/app/build.gradle", "ios/Podfile"],
  cocoapods: ["ios/Podfile", "ios/Podfile.lock", "package.json"],
  signing: ["android/app/build.gradle", "eas.json", "ios/*.xcodeproj/project.pbxproj"],
  "new-arch": ["package.json (codegenConfig)", "app.json (plugins)", "android/gradle.properties (newArchEnabled)"],
  "config-plugin": ["app.json (plugins)", "app.config.js", "package.json"],
  memory: ["android/gradle.properties (org.gradle.jvmargs)", "eas.json (resourceClass)"],
  unknown: [],
};

const AVOID_ALWAYS = "Do not add @ts-ignore, @Suppress, try!, or skip tests to make the build pass.";
const AVOID: Partial<Record<MobileBuildCategory, string>> = {
  version: "Do not downgrade packages to make the error go away.",
  "new-arch": "Do not set newArchEnabled=false.",
  signing: "Do not create or change certificates, profiles, or keystores; tell the person what is missing.",
  "config-plugin":
    "Do not edit the generated android/ or ios/ folders by hand when app.json drives them; fix the plugin config instead.",
};

type Suggestion = NonNullable<MobileBuildBrief["suggestion"]>;

/** Classifies the log and adds what ZLI knows about the worktree's app. */
export async function buildBrief(
  host: MobileDevHost,
  worktreeId: string,
  log: string,
  options: { logCut?: boolean } = {},
): Promise<MobileBuildBrief> {
  const facts = await projectFacts(host, worktreeId).catch(() => undefined);
  return composeBrief(classifyBuildLog(log), facts, options);
}

export function composeBrief(
  classification: BuildClassification,
  facts: MobileProjectFactsCore | undefined,
  options: { logCut?: boolean } = {},
): MobileBuildBrief {
  const { category } = classification;
  const appDir = facts && facts.appDir !== "." ? facts.appDir.replace(/\/+$/u, "") : undefined;
  const inApp = (file: string) => (appDir ? `${appDir}/${file}` : file);
  const likelyFiles = [...LIKELY_FILES[category], ...filesFromError(classification.firstError.line)]
    .map(inApp)
    .filter((file, index, all) => all.indexOf(file) === index)
    .slice(0, 20);
  const avoid = [AVOID[category], AVOID_ALWAYS].filter((line): line is string => line !== undefined);
  const versionFindings = sortFindings(facts?.findings ?? []).slice(0, 50);
  const suggestion = suggest(classification, facts, appDir);
  const fields = {
    stack: classification.stack,
    category,
    confidence: classification.confidence,
    firstError: {
      line: classification.firstError.line,
      lineNumber: classification.firstError.lineNumber,
      context: [...classification.firstError.context],
    },
    ...(classification.phase ? { phase: classification.phase.slice(0, 200) } : {}),
    versionFindings,
    versionChecked: facts !== undefined,
    likelyFiles,
    avoid,
    ...(options.logCut ? { logCut: true } : {}),
    ...(suggestion ? { suggestion } : {}),
  };
  return { ...fields, text: renderBrief(fields) };
}

/** The brief as one message for an agent, at most 4,000 characters. Context shrinks first when it is too long. */
export function renderBrief(brief: Omit<MobileBuildBrief, "text">): string {
  const header = [
    `Build failure: ${BUILD_CATEGORY_LABELS[brief.category]} (${BUILD_STACK_LABELS[brief.stack]}, ${brief.confidence} confidence).`,
    ...(brief.phase ? [`Failed in ${brief.phase}.`] : []),
    "",
    ...versionLines(brief),
    "",
    brief.logCut
      ? `First error, line ${brief.firstError.lineNumber} of the log's last 2 MB, the part ZLI read:`
      : `First error, line ${brief.firstError.lineNumber}:`,
    `  ${brief.firstError.line}`,
  ];
  const footer = [
    ...(brief.likelyFiles.length > 0 ? ["", "Likely files:", ...brief.likelyFiles.map((file) => `- ${file}`)] : []),
    "",
    "Avoid:",
    ...brief.avoid.map((line) => `- ${line}`),
    ...(brief.suggestion ? ["", `First step: ${brief.suggestion.text}`] : []),
    ...(brief.suggestion?.action?.kind === "command"
      ? [`Propose: ${proposalCommandLine(brief.suggestion.action)} (mobile_propose)`]
      : []),
  ];
  const context = brief.firstError.context;
  const errorAt = context.findIndex((line) => line.trim() === brief.firstError.line.trim());
  for (const around of [20, 12, 8, 4, 2, 0]) {
    const center = errorAt < 0 ? Math.floor(context.length / 2) : errorAt;
    const shown = around === 0 ? [] : context.slice(Math.max(0, center - around), center + around + 1);
    const text = [...header, ...(shown.length > 0 ? ["", "Log around it:", ...shown] : []), ...footer].join("\n");
    if (text.length <= TEXT_MAX) return text;
  }
  const text = [...header, ...footer].join("\n");
  return text.length <= TEXT_MAX ? text : `${text.slice(0, TEXT_MAX - 1)}…`;
}

function versionLines(brief: Omit<MobileBuildBrief, "text">): string[] {
  if (brief.versionChecked === false) return ["Version checks did not run."];
  if (brief.versionFindings.length === 0) return ["Version checks found no problems."];
  return [
    "Version checks:",
    ...brief.versionFindings.slice(0, 8).map((finding) => `- ${finding.severity}: ${finding.title}`),
    ...(brief.versionFindings.length > 8 ? [`- and ${brief.versionFindings.length - 8} more.`] : []),
  ];
}

function sortFindings(findings: readonly MobileFinding[]): MobileFinding[] {
  const rank = { error: 0, warning: 1, info: 2 } as const;
  return [...findings].sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/** Source files the error line names inside the project, such as the file an import failed in. */
function filesFromError(line: string): string[] {
  const files = [
    ...line.matchAll(
      /(?:^|[\s'"(])((?:\.{0,2}\/)?(?:[\w@.-]+\/)*[\w@.-]+\.(?:[jt]sx?|kts?|gradle|swift|mm?|java))\b/gu,
    ),
  ]
    .map((match) => (match[1] ?? "").replace(/^\.\//u, ""))
    .filter((file) => file && !file.startsWith("/") && !file.startsWith("..") && !file.includes("node_modules/"));
  return files.slice(0, 3);
}

function suggest(
  classification: BuildClassification,
  facts: MobileProjectFactsCore | undefined,
  appDir: string | undefined,
): Suggestion | undefined {
  const expo = facts ? facts.stack === "expo" : classification.expo;
  const folder = (sub: string) => (sub === "." ? (appDir ?? ".") : appDir ? `${appDir}/${sub}` : sub);
  const command = (title: string, text: string, action: unknown): Suggestion => ({
    text,
    title,
    // Every suggested command must be one a proposal can carry; a bad one is a bug here, not the person's problem.
    action: MobileProposalAction.parse(action),
  });
  const { signal } = classification;
  switch (classification.category) {
    case "version":
      return expo
        ? command("Fix package versions", "Let Expo pick the package versions that match this SDK.", {
            kind: "command",
            program: "npx",
            args: ["expo", "install", "--fix"],
            cwd: folder("."),
            env: { CI: "1" },
          })
        : { text: "Align the versions the error names with the ones this React Native version expects, then rebuild." };
    case "cocoapods":
      return command("Install pods", "Install the pods again so they match the Podfile and the current specs.", {
        kind: "command",
        program: "pod",
        args: signal?.includes("compatible versions") ? ["install", "--repo-update"] : ["install"],
        cwd: folder("ios"),
      });
    case "jdk-gradle":
      return { text: "Install JDK 17 and point JAVA_HOME to it." };
    case "memory":
      // On Linux, Metro and Watchman also hit ENOSPC when the inotify watch limit is reached; that is not disk.
      if (signal?.includes("ENOSPC"))
        return /watchers?|inotify/iu.test(classification.firstError.line)
          ? {
              text: "The machine hit its file-watcher limit, not a disk limit. Raise fs.inotify.max_user_watches (for example, sysctl fs.inotify.max_user_watches=524288), then rebuild.",
            }
          : { text: "The build machine ran out of disk space. Free space, or use a larger EAS resource class." };
      return {
        text: "Give Gradle more memory: raise -Xmx in org.gradle.jvmargs in android/gradle.properties, such as -Xmx4g.",
      };
    case "signing":
      return {
        text: "Tell the person which certificate, provisioning profile, team, or keystore is missing. They set it up in Xcode or with EAS credentials.",
      };
    case "config-plugin":
      return expo
        ? command("Check the Expo config", "Load the Expo config with every plugin, which shows the failing plugin.", {
            kind: "command",
            program: "npx",
            args: ["expo", "config", "--type", "introspect"],
            cwd: folder("."),
          })
        : { text: "Check the plugin entries in app.json: each package must be installed and export a config plugin." };
    case "new-arch":
      return {
        text: "Check that each library the error names supports the New Architecture and declares its codegenConfig, then rebuild.",
      };
    case "native-module":
      return signal?.includes("Duplicate class")
        ? { text: "Two libraries ship the same class. Find which with ./gradlew :app:dependencies and exclude one." }
        : { text: "Check that the module is installed and linked: install dependencies again, then rebuild." };
    case "unknown":
      return undefined;
  }
}
