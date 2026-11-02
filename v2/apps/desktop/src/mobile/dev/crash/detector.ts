import {
  type CrashBlock,
  CrashBlockScanner,
  isFrameLine,
  type MobileCrashKind,
  type ParsedLogLine,
  parseLogLine,
} from "@zli-v2/contracts";

/** One crash read from a block of log lines. */
export type DetectedCrash = {
  readonly kind: MobileCrashKind;
  readonly appId: string | undefined;
  readonly title: string;
  readonly frames: readonly string[];
  /** Equal for repeats of the same crash: the exception plus the top frames from the app. */
  readonly signature: string;
  readonly lines: readonly string[];
  /** Set when this block adds a native tombstone to the crash with this signature instead of being a new one. */
  readonly updates?: string;
};

const MAX_FRAMES = 8;
const TOMBSTONE_WINDOW_MS = 10_000;

/**
 * Reads crashes out of a device log, one line at a time. Lines are grouped by CrashBlockScanner; this turns each
 * block into a title, frames, and a signature, and remembers which package each pid belongs to.
 */
export class CrashDetector {
  readonly #scanner = new CrashBlockScanner();
  readonly #packages = new Map<string, string>();
  #lastNative: { signature: string; time: number | undefined; pid: string | undefined } | undefined;

  /** Whether a crash block is open and waits for more lines or flush(). */
  get pending(): boolean {
    return this.#scanner.open;
  }

  push(raw: string): DetectedCrash[] {
    this.#learnPackage(parseLogLine(raw));
    return this.#read(this.#scanner.push(raw).closed);
  }

  flush(): DetectedCrash[] {
    return this.#read(this.#scanner.flush());
  }

  #learnPackage(line: ParsedLogLine): void {
    const started = /Start proc (\d+):([\w.]+)/u.exec(line.message);
    if (started?.[1] && started[2]) this.#remember(started[1], started[2]);
    const process = /^Process: ([\w.]+), PID: (\d+)/u.exec(line.message);
    if (process?.[1] && process[2]) this.#remember(process[2], process[1]);
  }

  #remember(pid: string, appId: string): void {
    this.#packages.delete(pid);
    this.#packages.set(pid, appId);
    if (this.#packages.size > 200) this.#packages.delete(this.#packages.keys().next().value as string);
  }

  #read(blocks: readonly CrashBlock[]): DetectedCrash[] {
    const crashes: DetectedCrash[] = [];
    for (const block of blocks) {
      const crash = this.#describe(block);
      if (crash) crashes.push(crash);
    }
    return crashes;
  }

  #describe(block: CrashBlock): DetectedCrash | undefined {
    const lines = block.lines.map((line) => line.raw);
    const base = { lines };
    switch (block.kind) {
      case "java":
      case "js-error": {
        const crash = this.#java(block);
        return crash ? { ...base, ...crash } : undefined;
      }
      case "anr": {
        const head = block.lines[0];
        const match = /^ANR in ([\w.]+)/u.exec(head?.message ?? "");
        if (!match?.[1]) return undefined;
        const reason = block.lines.find((line) => /^Reason: /u.test(line.message))?.message.slice(8);
        const title = `ANR in ${match[1]}${reason ? `: ${reason}` : ""}`;
        return { ...base, kind: "anr", appId: match[1], title, frames: [], signature: `anr|${match[1]}` };
      }
      case "native":
        return this.#native(block, lines);
      case "ios-exception":
        return { ...base, ...this.#ios(block) };
    }
  }

  #java(block: CrashBlock): Omit<DetectedCrash, "lines"> | undefined {
    const messages = block.lines.map((line) => line.message);
    const processLine = messages.map((message) => /^Process: ([\w.]+), PID: (\d+)/u.exec(message)).find(Boolean);
    const pid = processLine?.[2] ?? block.lines.find((line) => line.pid)?.pid;
    const appId = processLine?.[1] ?? (pid ? this.#packages.get(pid) : undefined);
    const fatal = messages.findIndex((message) => /FATAL EXCEPTION/u.test(message));
    const exception = messages.find(
      (message, index) =>
        index > fatal && fatal >= 0 && !/^Process: /u.test(message) && /^[\w$]+(?:\.[\w$]+)+(?::|$)/u.test(message),
    );
    const javascript = messages.find((message) => /com\.facebook\.react\.common\.JavascriptException/u.test(message));
    const reactLine = messages.find(
      (message, index) =>
        block.lines[index]?.tag === "ReactNativeJS" && /Invariant Violation|TypeError|ReferenceError/u.test(message),
    );
    let title: string | undefined;
    let className: string | undefined;
    if (javascript) {
      title = javascript.replace(/^.*JavascriptException:\s*/u, "").replace(/,\s*(?:js engine:.*|stack:)\s*$/u, "");
      className = title.split(":")[0];
    } else if (reactLine) {
      title = reactLine.trim();
      className = title.split(":")[0];
    } else if (exception) {
      title = exception.trim();
      className = title.split(":")[0];
    }
    if (!title) return undefined;
    const frames = block.lines.filter((line) => isFrameLine(line.message)).map((line) => line.message.trim());
    const kind: MobileCrashKind = javascript || reactLine ? "js-error" : "java";
    return {
      kind,
      appId,
      title: cut(title, 300),
      frames: frames.slice(0, MAX_FRAMES),
      signature: signature(kind, className ?? title, frames, appId),
    };
  }

  #native(block: CrashBlock, lines: readonly string[]): DetectedCrash | undefined {
    const messages = block.lines.map((line) => line.message.trim());
    const fatal = messages.find((message) => /Fatal signal \d+ \(SIG/u.test(message));
    const signal = messages.find((message) => /^signal \d+ \(SIG\w+\)/u.test(message));
    const badAccess = messages.find((message) => /EXC_BAD_ACCESS/u.test(message));
    const cause = messages.find((message) => /^Cause: /u.test(message))?.slice(7);
    const pid =
      /pid (\d+)/u.exec(fatal ?? "")?.[1] ??
      /^pid: (\d+),/u.exec(messages.find((message) => /^pid: \d+,/u.test(message)) ?? "")?.[1];
    const appId =
      /pid \d+ \(([\w.]+)\)/u.exec(fatal ?? "")?.[1] ??
      />>> ([\w.]+) <<</u.exec(messages.join("\n"))?.[1] ??
      (pid ? this.#packages.get(pid) : undefined);
    const frames = messages
      .filter((message) => /^#\d+\s+pc\s/u.test(message))
      .map((message) => message.replace(/\s*\(BuildId: [^)]*\)$/u, "").replace(/\s+/gu, " "));
    const headline = fatal ? fatal.replace(/\s+in tid \d+.*$/u, "") : signal ? `Fatal ${signal}` : badAccess;
    if (!headline) return undefined;
    const title = cut(`${headline}${cause ? ` (${cause})` : ""}`, 300);
    const signalName = /\((SIG\w+)\)/u.exec(headline)?.[1] ?? headline;
    const time = block.lines[0]?.time;
    const last = this.#lastNative;
    // The tombstone of a native crash arrives after the libc line, often with other lines in between.
    if (
      !fatal &&
      last &&
      (pid === undefined || last.pid === undefined || pid === last.pid) &&
      (time === undefined || last.time === undefined || time - last.time <= TOMBSTONE_WINDOW_MS)
    ) {
      this.#lastNative = undefined;
      return {
        kind: "native",
        appId,
        title,
        frames: frames.slice(0, MAX_FRAMES),
        signature: last.signature,
        lines,
        updates: last.signature,
      };
    }
    const crash: DetectedCrash = {
      kind: "native",
      appId,
      title,
      frames: frames.slice(0, MAX_FRAMES),
      signature: `native|${appId ?? ""}|${signalName}`,
      lines,
    };
    this.#lastNative = fatal ? { signature: crash.signature, time, pid } : undefined;
    return crash;
  }

  #ios(block: CrashBlock): Omit<DetectedCrash, "lines"> {
    const head = block.lines[0];
    const message = head?.message ?? "";
    const thrown = /uncaught exception '([^']+)', reason: '(.*)'\s*$/u.exec(message);
    const title = thrown ? `${thrown[1]}: ${thrown[2]}` : message.replace(/^\[[^\]]*\]\s*/u, "").trim();
    const subsystem = block.lines
      .map((line) => /^\[([\w.-]+):/u.exec(line.message)?.[1])
      .find((name) => name && !name.startsWith("com.apple."));
    const appId = subsystem ?? head?.tag;
    const frames = block.lines
      .filter((line) => /^\s*\d+\s+\S+\s+0x[0-9a-f]+\s/iu.test(line.message))
      .map((line) => line.message.trim().replace(/\s+/gu, " "));
    const kind: MobileCrashKind = thrown || /uncaught exception/u.test(message) ? "ios-exception" : "native";
    return {
      kind,
      appId,
      title: cut(title, 300),
      frames: frames.slice(0, MAX_FRAMES),
      signature: signature(kind, thrown?.[1] ?? title, frames, head?.tag),
    };
  }
}

/** The exception plus its first three frames from the app, or the first three frames when none are the app's. */
function signature(
  kind: MobileCrashKind,
  className: string,
  frames: readonly string[],
  appId: string | undefined,
): string {
  const own = appId ? frames.filter((frame) => frame.includes(appId)) : [];
  const top = (own.length > 0 ? own : frames).slice(0, 3).map((frame) => frame.replace(/0x[0-9a-f]+/giu, ""));
  return [kind, className.trim(), ...top].join("|");
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
