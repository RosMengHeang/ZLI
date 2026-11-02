import type { MobileFinding, MobileProjectFacts, MobileProposalAction } from "@zli-v2/contracts";

import { javaMajor } from "./probes.js";
import { compareVersions, major, minorOf } from "./readProject.js";

/** The facts a rule looks at: everything the doctor knows except the findings themselves. */
export type IssueFacts = Omit<MobileProjectFacts, "findings" | "fingerprint" | "checkedAt" | "worktreeId">;

export type KnownIssue = {
  readonly id: string;
  readonly severity: MobileFinding["severity"];
  when(facts: IssueFacts): boolean;
  title(facts: IssueFacts): string;
  detail(facts: IssueFacts): string;
  /** The command that fixes it. It only ever becomes a proposal the person runs. */
  fix?(facts: IssueFacts): MobileProposalAction;
  /** The proposal's title, as the person reads it on the card. */
  fixTitle?(facts: IssueFacts): string;
  source(facts: IssueFacts): string | undefined;
};

/** The React Native minor each Expo SDK ships with. */
export const EXPO_SDK_REACT_NATIVE: Readonly<Record<number, string>> = {
  52: "0.76",
  53: "0.79",
  54: "0.81",
  55: "0.83",
  56: "0.85",
  57: "0.86",
};

const SDK_SOURCES: Readonly<Record<number, string>> = {
  55: "https://expo.dev/blog/upgrading-to-sdk-55",
  56: "https://expo.dev/changelog/sdk-56",
  57: "https://expo.dev/changelog/sdk-57",
};

const sdk = (facts: IssueFacts) => (facts.stack === "expo" ? major(facts.versions.expo) : undefined);
const rnMinor = (facts: IssueFacts) => minorOf(facts.versions["react-native"]);
const expoFix = (facts: IssueFacts, args: string[]): MobileProposalAction => ({
  kind: "command",
  program: "npx",
  args,
  cwd: facts.appDir,
  env: { CI: "1" },
});

export const KNOWN_ISSUES: readonly KnownIssue[] = [
  {
    id: "newarch-optout-removed",
    severity: "error",
    when: (facts) =>
      ((sdk(facts) ?? 0) >= 55 || (rnMinor(facts) ?? 0) >= 82) && (facts.newArch?.disabledIn?.length ?? 0) > 0,
    title: (facts) => `newArchEnabled is false in ${facts.newArch?.disabledIn?.join(" and ")}`,
    detail: () =>
      "SDK 55 and later cannot turn off the New Architecture, so this build fails. Remove newArchEnabled=false and update packages that need the old architecture.",
    source: () => "https://docs.expo.dev/guides/new-architecture/",
  },
  {
    id: "jdk-too-old",
    severity: "error",
    when: (facts) => {
      const java = javaMajor(facts.host?.java);
      return (rnMinor(facts) ?? 0) >= 73 && java !== undefined && java < 17;
    },
    title: (facts) => `Java ${facts.host?.java} is too old for React Native ${facts.versions["react-native"]}`,
    detail: () => "React Native 0.73 and later build with JDK 17. Install JDK 17 and point JAVA_HOME to it.",
    source: () => "https://reactnative.dev/docs/set-up-your-environment",
  },
  {
    id: "expo-sdk-rn-mismatch",
    severity: "warning",
    when: (facts) => {
      const expected = EXPO_SDK_REACT_NATIVE[sdk(facts) ?? -1];
      const actual = facts.versions["react-native"];
      return (
        expected !== undefined && actual !== undefined && !actual.startsWith(`${expected}.`) && actual !== expected
      );
    },
    title: (facts) => `React Native ${facts.versions["react-native"]} does not match Expo SDK ${sdk(facts)}`,
    detail: (facts) =>
      `Expo SDK ${sdk(facts)} expects React Native ${EXPO_SDK_REACT_NATIVE[sdk(facts) ?? -1]}. Mismatched versions are a common cause of native build failures. npx expo install --fix picks the versions this SDK expects.`,
    fix: (facts) => expoFix(facts, ["expo", "install", "--fix"]),
    fixTitle: (facts) => `Match packages to Expo SDK ${sdk(facts)}`,
    source: (facts) => SDK_SOURCES[sdk(facts) ?? -1] ?? "https://docs.expo.dev/versions/latest/",
  },
  {
    id: "expo-install-check",
    severity: "warning",
    when: (facts) => (facts.deep?.expoInstallCheck?.packages.length ?? 0) > 0,
    title: (facts) => {
      const count = facts.deep?.expoInstallCheck?.packages.length ?? 0;
      return count === 1 ? "1 package does not match this Expo SDK" : `${count} packages do not match this Expo SDK`;
    },
    detail: (facts) =>
      `expo install --check reported: ${facts.deep?.expoInstallCheck?.packages.join(", ")}. npx expo install --fix installs the versions this SDK expects.`,
    fix: (facts) => expoFix(facts, ["expo", "install", "--fix"]),
    fixTitle: () => "Match packages to this Expo SDK",
    source: () => "https://docs.expo.dev/more/expo-cli/#install",
  },
  {
    id: "expo-go-sdk55",
    severity: "warning",
    when: (facts) => (sdk(facts) ?? 0) >= 55 && !facts.devClient && facts.client?.kind === "expo-go",
    title: () => "Expo Go from the App Store cannot open this app",
    detail: () =>
      "The App Store's Expo Go stops at SDK 54. Use a development build on a physical iPhone. The Android emulator can still install a matching Expo Go.",
    fix: (facts) => expoFix(facts, ["expo", "install", "expo-dev-client"]),
    fixTitle: () => "Add expo-dev-client",
    source: () => "https://docs.expo.dev/troubleshooting/expo-go-version-mismatch/",
  },
  {
    id: "agp9-optout-flags",
    severity: "warning",
    when: (facts) => {
      const flags = facts.android?.builtInKotlinOptOut === true || facts.android?.newDslOptOut === true;
      const agp = facts.android?.agp;
      return flags && (agp === undefined || compareVersions(agp, "9") >= 0);
    },
    title: () => "gradle.properties opts out of Android Gradle Plugin 9 changes",
    detail: (facts) => {
      const flags = [
        facts.android?.builtInKotlinOptOut ? "android.builtInKotlin=false" : undefined,
        facts.android?.newDslOptOut ? "android.newDsl=false" : undefined,
      ].filter(Boolean);
      return `It sets ${flags.join(" and ")}. Google says these opt-out flags stop working in summer 2026, so plan the migration instead of adding more.`;
    },
    source: () => "https://developer.android.com/build/releases/agp-9-0-0-release-notes",
  },
  {
    id: "pods-drift",
    severity: "warning",
    when: (facts) => facts.ios?.podsDrift === true,
    title: () => "Installed pods do not match Podfile.lock",
    detail: () =>
      'ios/Pods/Manifest.lock differs from ios/Podfile.lock, so Xcode stops with "The sandbox is not in sync with the Podfile.lock". Run pod install in ios.',
    fix: (facts) => ({
      kind: "command",
      program: "pod",
      args: ["install"],
      cwd: facts.stack === "ios" ? facts.appDir : facts.appDir === "." ? "ios" : `${facts.appDir}/ios`,
    }),
    fixTitle: () => "Install pods",
    source: () =>
      "https://stackoverflow.com/questions/44942889/the-sandbox-is-not-in-sync-with-the-podfile-lock-run-pod-install-or-update-yo",
  },
  {
    id: "cocoapods-trunk",
    severity: "info",
    when: (facts) => facts.ios?.podfile === true,
    title: () => "CocoaPods trunk becomes read-only on December 2, 2026",
    detail: () =>
      "Pods already published keep working, but new versions of many libraries will only ship through Swift Package Manager.",
    source: () => "https://www.courier.com/blog/cocoapods-end-of-life-heres-what-to-do",
  },
  {
    id: "npm-install-in-expo",
    severity: "info",
    when: (facts) => facts.stack === "expo",
    title: () => "Install packages with npx expo install",
    detail: () =>
      "npx expo install picks the version that matches this SDK. Plain npm install can add a native module that does not match, and the build fails later.",
    source: () => "https://docs.expo.dev/more/expo-cli/#install",
  },
];

const ORDER: Record<MobileFinding["severity"], number> = { error: 0, warning: 1, info: 2 };

/** The known problems these facts show, errors first. */
export function findIssues(facts: IssueFacts): MobileFinding[] {
  const findings: MobileFinding[] = KNOWN_ISSUES.filter((issue) => issue.when(facts)).map((issue) => {
    const source = issue.source(facts);
    return {
      id: issue.id,
      severity: issue.severity,
      title: issue.title(facts).slice(0, 200),
      detail: issue.detail(facts).slice(0, 1_000),
      ...(issue.fix ? { fix: issue.fix(facts) } : {}),
      ...(source ? { source } : {}),
    };
  });
  for (const file of facts.unreadable ?? []) {
    findings.push({
      id: `unreadable:${file}`.slice(0, 80),
      severity: "info",
      title: `ZLI could not read ${file}`.slice(0, 200),
      detail: "It is not valid JSON, so what it sets is unknown here.",
    });
  }
  return findings.sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
}

/** The title for the proposal that applies a finding's fix. */
export function fixTitleFor(findingId: string, facts: IssueFacts): string | undefined {
  return KNOWN_ISSUES.find((issue) => issue.id === findingId)?.fixTitle?.(facts);
}
