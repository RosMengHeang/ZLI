import { z } from "zod";

import { MobileControlDeviceInput } from "./mobile.js";
import { MobileFinding, MobileProposalAction } from "./mobileDev.js";

// Crash watch (F4)

export const MobileCrashKind = z.enum(["java", "native", "anr", "ios-exception", "js-error"]);
export type MobileCrashKind = z.infer<typeof MobileCrashKind>;

/** A crash ZLI caught in a device's log. Repeats of the same exception and top frames share one report. */
export const MobileCrashReport = z.object({
  crashId: z.string().min(1).max(80),
  deviceId: z.string().min(1).max(300),
  /** Package name or bundle id, when the log names it. */
  appId: z.string().max(300).optional(),
  kind: MobileCrashKind,
  title: z.string().max(300),
  frames: z.array(z.string().max(500)).max(8),
  /** Log lines before and through the crash, oldest first. */
  tail: z.array(z.string().max(500)).max(30),
  firstSeen: z.string().datetime({ offset: true }),
  lastSeen: z.string().datetime({ offset: true }),
  count: z.number().int().min(1),
  /** Who held the device when it crashed, such as "The agent in feat-login". */
  heldBy: z.string().max(200).optional(),
  /** The person dismissed it in the Mobile panel. A repeat brings it back. */
  dismissed: z.boolean().optional(),
});
export type MobileCrashReport = z.infer<typeof MobileCrashReport>;
export const MobileCrashList = z.array(MobileCrashReport).max(20);

export const MobileCrashEvent = z.object({ deviceId: z.string().min(1).max(300), reports: MobileCrashList });
export type MobileCrashEvent = z.infer<typeof MobileCrashEvent>;

export const MobileControlCrashesInput = MobileControlDeviceInput;
export type MobileControlCrashesInput = z.infer<typeof MobileControlCrashesInput>;

export const MobileCrashListInput = z.object({ deviceId: z.string().min(1).max(300) });
export const MobileCrashDismissInput = MobileCrashListInput.extend({ crashId: z.string().min(1).max(80) });

/** e2e: log lines the fake emulator prints, as if logcat streamed them. Without deviceId, the first running device. */
export const MobileTestEmitLogInput = z.object({
  deviceId: z.string().min(1).max(300).optional(),
  lines: z.array(z.string().max(4_000)).max(5_000),
});

/** One log line split into its parts. Android threadtime and iOS compact lines have a time and a tag. */
export type ParsedLogLine = {
  readonly raw: string;
  readonly format: "android" | "ios" | undefined;
  /** Milliseconds, comparable only between lines of the same log. */
  readonly time: number | undefined;
  /** The logcat tag, or the process name on iOS. */
  readonly tag: string | undefined;
  readonly pid: string | undefined;
  readonly message: string;
};

const ANDROID_LINE =
  /^(\d\d)-(\d\d)\s+(\d\d):(\d\d):(\d\d)\.(\d{3})\s+(\d+)\s+(\d+)\s+[VDIWEFA]\s+([^:]*?)\s*:(?: (.*))?$/u;
const IOS_LINE =
  /^\d{4}-(\d\d)-(\d\d)\s+(\d\d):(\d\d):(\d\d)\.(\d{3})\d*(?:[+-]\d{4})?\s+\w+\s+([^[\s]+)\[(\d+):[0-9a-fx]+\]\s?(.*)$/u;

export function parseLogLine(raw: string): ParsedLogLine {
  const android = ANDROID_LINE.exec(raw);
  const match = android ?? IOS_LINE.exec(raw);
  if (!match) return { raw, format: undefined, time: undefined, tag: undefined, pid: undefined, message: raw };
  const [month = 0, day = 0, hours = 0, minutes = 0, seconds = 0, millis = 0] = match.slice(1, 7).map(Number);
  const time = ((((month * 31 + day) * 24 + hours) * 60 + minutes) * 60 + seconds) * 1_000 + millis;
  return android
    ? { raw, format: "android", time, pid: android[7], tag: android[9]?.trim(), message: android[10] ?? "" }
    : { raw, format: "ios", time, tag: match[7], pid: match[8], message: match[9] ?? "" };
}

/** A stack frame line in Java, native tombstone, iOS, or React Native component and JS stacks. */
export function isFrameLine(message: string): boolean {
  return (
    /^\s*at\s+\S/u.test(message) ||
    /^\s*\.\.\.\s+\d+\s+more/u.test(message) ||
    /^\s*#\d+\s+pc\s/u.test(message) ||
    /^\s*\d+\s+\S+\s+0x[0-9a-f]+\s/iu.test(message) ||
    /^\s+in\s+\S+/u.test(message) ||
    /^[\w$.<>]+@\d+:\d+$/u.test(message.trim())
  );
}

/** Whether a line starts a crash block, and which kind. */
export function crashStart(line: ParsedLogLine): MobileCrashKind | undefined {
  const { message, tag } = line;
  if (/com\.facebook\.react\.common\.JavascriptException/u.test(message)) return "js-error";
  if (/FATAL EXCEPTION/u.test(message)) return "java";
  if (tag === "AndroidRuntime" && /Shutting down VM/u.test(message)) return "java";
  if (/^ANR in \S/u.test(message)) return "anr";
  if (/Fatal signal \d+ \(SIG/u.test(message)) return "native";
  if (tag === "DEBUG" && /^(?:\*\*\* \*\*\* \*\*\*|backtrace:)/u.test(message.trim())) return "native";
  if (/Terminating app due to uncaught exception/u.test(message)) return "ios-exception";
  if (/EXC_BAD_ACCESS/u.test(message)) return "native";
  if (tag === "ReactNativeJS" && /Invariant Violation|TypeError|ReferenceError/u.test(message)) return "js-error";
  return undefined;
}

/** The tags whose lines continue a block. On iOS that is the crashing process. */
function blockTags(kind: MobileCrashKind, line: ParsedLogLine): Set<string> {
  if (line.format === "ios" && line.tag) return new Set([line.tag]);
  switch (kind) {
    case "native":
      return new Set(["libc", "DEBUG", "crash_dump32", "crash_dump64", "tombstoned"]);
    case "anr":
      return new Set(["ActivityManager"]);
    case "js-error":
      // React Native logs the JS error first, then AndroidRuntime reports the same error as fatal.
      return new Set(["ReactNativeJS", "AndroidRuntime"]);
    default:
      return new Set(["AndroidRuntime"]);
  }
}

/** The lines of one crash in the log, before titles and frames are read from them. */
export type CrashBlock = { readonly kind: MobileCrashKind; readonly lines: readonly ParsedLogLine[] };

export const CRASH_BLOCK_GAP_MS = 300;
/** Lines of the block's own tags still belong to it after this long; later ones start over. */
const OWN_TAG_GAP_MS = 1_000;
export const CRASH_BLOCK_MAX_FRAMES = 40;
const HEADLINE = /FATAL EXCEPTION|^ANR in /u;

type OpenBlock = {
  kind: MobileCrashKind;
  readonly tags: Set<string>;
  readonly lines: ParsedLogLine[];
  lastTime: number | undefined;
  frames: number;
  headline: boolean;
};

/**
 * Groups log lines into crash blocks. A block starts at a crash signature and takes the lines of its own tags and
 * untimed continuation lines. It ends after 40 frame lines, or once a line from another tag comes more than 300 ms
 * after the block's last line, judged by the log's own timestamps.
 */
export class CrashBlockScanner {
  #open: OpenBlock | undefined;

  get open(): boolean {
    return this.#open !== undefined;
  }

  /** Reads one line. `included` says whether it belongs to a crash block; `closed` lists blocks it ended. */
  push(raw: string): { included: boolean; closed: CrashBlock[] } {
    const line = parseLogLine(raw);
    const closed: CrashBlock[] = [];
    const block = this.#open;
    if (block) {
      const gap = line.time === undefined || block.lastTime === undefined ? 0 : line.time - block.lastTime;
      const ownTag = line.tag !== undefined && block.tags.has(line.tag);
      // logcat's "--------- beginning of crash" buffer markers have no time but are not part of any crash.
      const untimed = line.time === undefined && !line.raw.startsWith("--------- ");
      const continues = untimed || (ownTag && gap <= OWN_TAG_GAP_MS);
      // A second FATAL EXCEPTION or ANR is the next crash, even in the same tag.
      const nextCrash = continues && block.headline && HEADLINE.test(line.message);
      if (continues && !nextCrash) {
        this.#append(block, line);
        if (block.frames >= CRASH_BLOCK_MAX_FRAMES) closed.push(this.#close());
        return { included: true, closed };
      }
      if (!continues && !ownTag && gap <= CRASH_BLOCK_GAP_MS && !crashStart(line)) return { included: false, closed };
      closed.push(this.#close());
    }
    const kind = crashStart(line);
    if (!kind) return { included: false, closed };
    this.#open = { kind, tags: blockTags(kind, line), lines: [], lastTime: undefined, frames: 0, headline: false };
    this.#append(this.#open, line);
    return { included: true, closed };
  }

  /** Ends the open block, as when the log goes quiet. */
  flush(): CrashBlock[] {
    return this.#open ? [this.#close()] : [];
  }

  #append(block: OpenBlock, line: ParsedLogLine): void {
    block.lines.push(line);
    if (line.time !== undefined) block.lastTime = line.time;
    if (isFrameLine(line.message)) block.frames += 1;
    if (HEADLINE.test(line.message)) block.headline = true;
    if (crashStart(line) === "js-error") block.kind = "js-error";
  }

  #close(): CrashBlock {
    const block = this.#open as OpenBlock;
    this.#open = undefined;
    return { kind: block.kind, lines: block.lines };
  }
}
/** For each line, whether it is part of a crash block, so the log view can mark it. */
export function crashLineMarks(lines: readonly string[]): boolean[] {
  const scanner = new CrashBlockScanner();
  return lines.map((line) => scanner.push(line).included);
}

/** The short form of a crash title for one line of UI: the exception class without its package. */
export function shortCrashTitle(title: string): string {
  return title.replace(/^(?:[a-z_][\w$]*\.)+(?=[A-Z][\w$]*(?::|$))/u, "");
}

/** A crash as plain text for an agent: the title, the top frames, and the log lines around it. */
export function crashReportText(report: MobileCrashReport): string {
  const who = report.appId ?? "The app";
  const lines = [`${who} crashed: ${report.title}`];
  if (report.count > 1) lines.push(`Seen ${report.count} times, last at ${report.lastSeen}.`);
  if (report.frames.length > 0) lines.push("", "Top frames:", ...report.frames.map((frame) => `  ${frame.trim()}`));
  if (report.tail.length > 0) lines.push("", `Last ${report.tail.length} log lines:`, ...report.tail);
  return lines.join("\n");
}

// Build brief (F5)

export const MobileBuildStack = z.enum(["gradle", "xcode", "eas", "metro", "unknown"]);
export type MobileBuildStack = z.infer<typeof MobileBuildStack>;

export const MobileBuildCategory = z.enum([
  "version",
  "jdk-gradle",
  "native-module",
  "cocoapods",
  "signing",
  "new-arch",
  "config-plugin",
  "memory",
  "unknown",
]);
export type MobileBuildCategory = z.infer<typeof MobileBuildCategory>;

export const BUILD_CATEGORY_LABELS: Record<MobileBuildCategory, string> = {
  version: "Version mismatch",
  "jdk-gradle": "JDK / Gradle",
  "native-module": "Autolinking / native module",
  cocoapods: "CocoaPods",
  signing: "Signing",
  "new-arch": "New Architecture / codegen",
  "config-plugin": "Config plugin",
  memory: "Memory / infra",
  unknown: "Unknown",
};

export const BUILD_STACK_LABELS: Record<MobileBuildStack, string> = {
  gradle: "Gradle",
  xcode: "Xcode",
  eas: "EAS Build",
  metro: "Metro",
  unknown: "Unknown",
};

export const MobileBuildBrief = z.object({
  stack: MobileBuildStack,
  category: MobileBuildCategory,
  confidence: z.enum(["high", "medium", "low"]),
  firstError: z.object({
    line: z.string().max(500),
    /** 1-based, in the text ZLI read. */
    lineNumber: z.number().int().min(1),
    context: z.array(z.string().max(500)).max(41),
  }),
  /** The EAS phase or failing Gradle task the first error sits in. */
  phase: z.string().max(200).optional(),
  versionFindings: z.array(MobileFinding).max(50),
  /** False when the doctor had no facts about this worktree. */
  versionChecked: z.boolean().optional(),
  likelyFiles: z.array(z.string().max(300)).max(20),
  avoid: z.array(z.string().max(300)).max(10),
  suggestion: z
    .object({
      text: z.string().max(600),
      /** The proposal card title when the suggestion has a command. */
      title: z.string().max(120).optional(),
      action: MobileProposalAction.optional(),
    })
    .optional(),
  /** The brief to hand an agent, at most 4,000 characters. */
  text: z.string().max(4_000),
});
export type MobileBuildBrief = z.infer<typeof MobileBuildBrief>;

export const MOBILE_BUILD_LOG_MAX = 2_000_000;

export const MobileBuildBriefInput = MobileControlDeviceInput.extend({
  log: z.string().max(MOBILE_BUILD_LOG_MAX).optional(),
  logPath: z.string().max(1_000).optional(),
}).refine((input) => (input.log === undefined) !== (input.logPath === undefined), {
  message: "Pass either log or logPath.",
});
export type MobileBuildBriefInput = z.infer<typeof MobileBuildBriefInput>;

/** The Mobile panel's Explain: a pasted log for the current worktree. */
export const MobileBuildPanelInput = z.object({
  worktreeId: z.string().min(1).max(200),
  log: z.string().min(1).max(MOBILE_BUILD_LOG_MAX),
});
export type MobileBuildPanelInput = z.infer<typeof MobileBuildPanelInput>;

/** Propose fix from the brief. Only commands; the card still needs Run in terminal. */
export const MobileBuildProposeInput = z.object({
  worktreeId: z.string().min(1).max(200),
  title: z.string().trim().min(1).max(120).optional(),
  reason: z.string().max(600).optional(),
  action: MobileProposalAction,
});
export type MobileBuildProposeInput = z.input<typeof MobileBuildProposeInput>;
