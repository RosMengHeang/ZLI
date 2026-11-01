import type { MobileBuildCategory, MobileBuildStack } from "@zli-v2/contracts";

/** What a build log says about itself, before the brief adds this project's facts. */
export type BuildClassification = {
  readonly stack: MobileBuildStack;
  readonly category: MobileBuildCategory;
  readonly confidence: "high" | "medium" | "low";
  readonly firstError: { readonly line: string; readonly lineNumber: number; readonly context: readonly string[] };
  readonly phase: string | undefined;
  /** The pattern that matched, so the brief can tell apart cases inside one class. */
  readonly signal: string | undefined;
  /** The log shows an Expo project, for when the doctor has no facts. */
  readonly expo: boolean;
};

type Rule = { readonly category: MobileBuildCategory; readonly patterns: readonly RegExp[] };

/**
 * One rule per failure class. Order breaks ties when two classes match the same line, so the more specific class
 * comes first: a JDK too new for Gradle reads as JDK / Gradle even though it is also a version problem.
 */
export const BUILD_RULES: readonly Rule[] = [
  {
    category: "memory",
    patterns: [
      // Bare "Metaspace" would also match the -XX:MaxMetaspaceSize flag every Gradle daemon prints.
      /java\.lang\.OutOfMemoryError|OutOfMemoryError: Metaspace|Java heap space|GC overhead limit exceeded/u,
      /Gradle build daemon disappeared unexpectedly|Daemon disappeared/u,
      /\bENOSPC\b|No space left on device/u,
      /JavaScript heap out of memory/u,
    ],
  },
  {
    category: "jdk-gradle",
    patterns: [
      /Unsupported class file major version \d+/u,
      /Unsupported Java\b/iu,
      /has been compiled by a more recent version of the Java Runtime/u,
      /Android Gradle plugin requires Java \d+/u,
      /Could not resolve com\.android\.tools\.build:gradle/u,
      /Gradle version [\d.]+ is required|Minimum supported Gradle version is/u,
      /JAVA_HOME is (?:set to an invalid directory|not set)/u,
      /No Java compiler found|Could not determine java version/u,
    ],
  },
  {
    category: "signing",
    patterns: [
      /No signing certificate/u,
      /Signing for "[^"]+" requires a development team/u,
      /No profiles for '[^']+' were found/u,
      /Provisioning profile .* doesn't (?:include|match)/u,
      /requires a provisioning profile/u,
      /Keystore file .* not found|Keystore was tampered with|keystore password was incorrect/iu,
      /Code ?Sign(?:ing)? error|CodeSign .* failed/iu,
    ],
  },
  {
    category: "config-plugin",
    patterns: [
      /\bPluginError\b/u,
      /Failed to resolve plugin for module/u,
      /Unable to resolve a valid config plugin/u,
      /Package "[^"]+" does not contain a valid config plugin/u,
    ],
  },
  {
    category: "new-arch",
    patterns: [
      /TurboModuleRegistry\.getEnforcing\(\.\.\.\): '[^']+' could not be found/u,
      /TurboModule\b.{0,300}?(?:not found|could not be found)/u,
      // RN's normal "[Codegen] Found codegenConfig ..." output is not a failure.
      /\[Codegen\].*(?:Could not|Error|error)|\bcodegenConfig\b.{0,160}(?:missing|invalid|not found|failed)/u,
      /Fabric component .* (?:not found|is not registered)|RCTFabric\S* error/u,
    ],
  },
  {
    category: "cocoapods",
    patterns: [
      /CocoaPods could not find compatible versions/u,
      /The sandbox is not in sync with the Podfile\.lock/u,
      // CocoaPods also prints "[!]" for plain warnings ("... does not explicitly specify ..."), which are not
      // the failure; only its error wording counts.
      /\[!\] .*(?:CocoaPods|Podfile|podspec|specification|Pod::|pod ")/iu,
      /pod install.* (?:failed|error)/iu,
    ],
  },
  {
    category: "version",
    patterns: [
      /requires a minimum Expo SDK/u,
      /Some dependencies are incompatible with the installed expo/u,
      /The following packages should be updated for best compatibility/u,
      /was compiled with an incompatible version of Kotlin|The binary version of its metadata is [\d.]+, expected version is/u,
      /is not compatible with (?:this version of )?(?:react-native|expo)\b/iu,
    ],
  },
  {
    category: "native-module",
    patterns: [
      /Unable to resolve module/u,
      /Could not find module|No such module '/u,
      /Duplicate class \S+ found in modules/u,
      /Native module \S+ (?:cannot be null|not found)|Cannot find native module/iu,
      /Could not find project :[\w-]+|Project with path ':[\w-]+' could not be found/u,
    ],
  },
];

const FALLBACK = /^FAILURE:|\berror:|^\s*ERROR\b|\*\* BUILD FAILED \*\*|^\s*e: /u;
const EAS_PHASE = /^\[([A-Z][A-Z0-9_]{2,})\]/u;
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "gu");
const CONTEXT = 20;
const LINE_MAX = 500;
/** A line longer than this is cut before any rule runs, so one minified line cannot mean quadratic matching. */
const MATCH_MAX = 4_096;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

export function detectStack(lines: readonly string[]): MobileBuildStack {
  const has = (pattern: RegExp) => lines.some((line) => pattern.test(line));
  if (
    has(
      /^\[(?:RUN_GRADLEW|INSTALL_PODS|PREBUILD|INSTALL_DEPENDENCIES|RUN_FASTLANE|READ_APP_CONFIG|SPIN_UP_BUILD_ENVIRONMENT)\]/u,
    ) ||
    has(/\beas build\b/u)
  )
    return "eas";
  if (has(/^> Task :|What went wrong:/u)) return "gradle";
  if (
    has(/\*\* BUILD FAILED \*\*/u) ||
    has(/\.swift:\d+(?::\d+)?: error: |error: .*\.swift:/u) ||
    has(/^\s*xcodebuild\b/u)
  )
    return "xcode";
  if (has(/Unable to resolve module|^\s*(?:Metro|Bundling failed)/u)) return "metro";
  return "unknown";
}

/**
 * Finds the first real error in a failed build log and the class of failure it belongs to. The first error is the
 * earliest line any class matches; with no match, the first FAILURE: or error: line.
 */
export function classifyBuildLog(text: string): BuildClassification {
  const lines = stripAnsi(text)
    .split(/\r?\n/u)
    .map((line) => (line.length > MATCH_MAX ? line.slice(0, MATCH_MAX) : line));
  const stack = detectStack(lines);
  let hit: { index: number; category: MobileBuildCategory; signal: string } | undefined;
  for (let index = 0; index < lines.length && !hit; index += 1) {
    const line = lines[index] ?? "";
    for (const rule of BUILD_RULES) {
      const pattern = rule.patterns.find((candidate) => candidate.test(line));
      if (pattern) {
        hit = { index, category: rule.category, signal: pattern.source };
        break;
      }
    }
  }
  const fallback = hit ? undefined : lines.findIndex((line) => FALLBACK.test(line));
  const index = hit?.index ?? (fallback !== undefined && fallback >= 0 ? fallback : lastNonEmpty(lines));
  const category = hit?.category ?? "unknown";
  const confidence = !hit ? "low" : stack === "unknown" ? "medium" : "high";
  return {
    stack,
    category,
    confidence,
    firstError: {
      line: cut((lines[index] ?? "").trim()),
      lineNumber: index + 1,
      context: lines.slice(Math.max(0, index - CONTEXT), index + CONTEXT + 1).map(cut),
    },
    phase: phaseOf(lines, index, stack),
    signal: hit?.signal,
    expo:
      stack === "eas" ||
      lines.some((line) => /node_modules\/(?:expo|expo-modules-core)\/|\bexpo prebuild\b/u.test(line)),
  };
}

/** The EAS phase the line sits in, else the Gradle task that failed. */
function phaseOf(lines: readonly string[], index: number, stack: MobileBuildStack): string | undefined {
  if (stack === "eas") {
    for (let at = index; at >= 0; at -= 1) {
      const phase = EAS_PHASE.exec(lines[at] ?? "")?.[1];
      if (phase) return phase;
    }
  }
  for (const line of lines) {
    const task = /> Task (:\S+) FAILED/u.exec(line)?.[1];
    if (task) return task;
  }
  for (const line of lines) {
    const task = /Execution failed for task '([^']+)'/u.exec(line)?.[1];
    if (task) return task;
  }
  return undefined;
}

function lastNonEmpty(lines: readonly string[]): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) if ((lines[index] ?? "").trim()) return index;
  return 0;
}

function cut(line: string): string {
  return line.length > LINE_MAX ? `${line.slice(0, LINE_MAX - 1)}…` : line;
}
