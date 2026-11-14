import { type ReactNode, useState } from "react";

import type { FileLinks } from "../files/FileIndex.js";
import { cx } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { CopyButton } from "./CopyButton.js";

export type TraceLocation = {
  file: string;
  line: number;
  column?: number | undefined;
  /** Where the location sits in the frame's text, so only that part becomes a link. */
  start: number;
  end: number;
};

export type StackFrame = {
  /** The frame as printed, without its indent. */
  text: string;
  location?: TraceLocation | undefined;
  /** The source line Python prints under a frame. */
  code?: string | undefined;
  /** Library and runtime frames, which are rarely where the bug is. */
  vendor: boolean;
};

export type ParsedTrace = {
  /** Output printed before the error, such as the command that ran. */
  before: string[];
  errorType?: string | undefined;
  message: string;
  frames: StackFrame[];
  after: string[];
};

const AT_CALL = /^at (?:.+? )?\((.+?):(\d+)(?::(\d+))?\)$/u;
const AT_PATH = /^at (.+?):(\d+)(?::(\d+))?$/u;
const AT_OTHER = /^at \S/u;
const PYTHON = /^File "(.+?)", line (\d+)(?:, in .+)?$/u;
const GO_PATH = /^((?:[A-Za-z]:)?[^\s:]*\.go):(\d+)(?: \+0x[0-9a-f]+)?$/u;
const GO_CALL = /^[\w./*()[\]-]+\(.*\)$/u;
const RUST_CALL = /^\d+: \S/u;
const PATHLIKE = /[\\/.]/u;
const VENDOR =
  /node_modules|site-packages|dist-packages|^at node:|\(node:|node:internal|internal[\\/]|[\\/]rustc[\\/]|\.cargo[\\/]registry|[\\/]lib[\\/]python\d|<frozen |<anonymous>|\(native\)|[\\/]go[\\/]src[\\/]|[\\/]libexec[\\/]src[\\/]|\b(?:std|core|alloc)::/u;
const HEAD =
  /^((?:[\w$]+\.)*[\w$]*(?:Error|Exception|Exit|Interrupt|Warning|Fault|Panic|Failure)|panic)(?::\s?(.*))?$/u;

function location(text: string, file: string, line: string, column: string | undefined): TraceLocation {
  // Python prints the path in quotes; the link covers the quotes so the label reads as printed.
  const label = text.startsWith("File ") ? `"${file}", line ${line}` : `${file}:${line}${column ? `:${column}` : ""}`;
  const start = Math.max(0, text.lastIndexOf(label));
  return {
    file,
    line: Number(line),
    ...(column ? { column: Number(column) } : {}),
    start,
    end: start + label.length,
  };
}

/** The file and line a single trimmed line points to, when it is a frame that names one. */
function frameAt(text: string): TraceLocation | undefined {
  const match = AT_CALL.exec(text) ?? AT_PATH.exec(text) ?? PYTHON.exec(text) ?? GO_PATH.exec(text);
  if (!match?.[1] || !match[2]) return undefined;
  return location(text, match[1], match[2], match[3]);
}

const frame = (text: string, at?: TraceLocation, code?: string): StackFrame => ({
  text,
  ...(at ? { location: at } : {}),
  ...(code ? { code } : {}),
  vendor: VENDOR.test(text),
});

const indentOf = (line: string) => line.length - line.trimStart().length;

/**
 * Finds a JavaScript, Python, Rust, or Go stack trace in command output or an error message. Returns
 * undefined when no frame names a file, so ordinary text that happens to start with "at" stays plain.
 */
export function parseStackTrace(text: string): ParsedTrace | undefined {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  const entries: (StackFrame | string)[] = [];
  let python = false;
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? "";
    const line = raw.trim();
    const next = lines[index + 1]?.trim() ?? "";
    const previous = entries.at(-1);
    const afterFrame = previous !== undefined && typeof previous !== "string";
    // Rust and Go print the function on one line and its file on the next; the two read as one frame.
    if ((RUST_CALL.test(line) && next.startsWith("at ")) || (GO_CALL.test(line) && GO_PATH.test(next))) {
      const at = frameAt(next);
      if (at) {
        const joined = `${line} ${next}`;
        entries.push(frame(joined, location(joined, at.file, String(at.line), at.column?.toString())));
        index += 1;
        continue;
      }
    }
    const at = frameAt(line);
    if (at && (line.startsWith("at ") || line.startsWith("File ") || indentOf(raw) > 0 || afterFrame)) {
      const isPython = line.startsWith("File ");
      python ||= isPython;
      // Python prints the source line under each frame, indented deeper than the frame itself.
      const source = lines[index + 1];
      const code =
        isPython && source && indentOf(source) > indentOf(raw) && !frameAt(source.trim()) ? source.trim() : undefined;
      entries.push(frame(line, at, code));
      if (code) index += 1;
      continue;
    }
    if (afterFrame && (AT_OTHER.test(line) || RUST_CALL.test(line))) {
      entries.push(frame(line));
      continue;
    }
    entries.push(raw);
  }

  const isFrame = (entry: StackFrame | string): entry is StackFrame => typeof entry !== "string";
  const first = entries.findIndex(isFrame);
  const last = entries.findLastIndex(isFrame);
  if (first < 0) return undefined;
  const frames = entries
    .slice(first, last + 1)
    .map((entry) => (typeof entry === "string" ? frame(entry.trim()) : entry))
    .filter((entry) => entry.text !== "");
  if (!frames.some((entry) => entry.location && PATHLIKE.test(entry.location.file))) return undefined;
  const before = entries.slice(0, first) as string[];
  const after = entries.slice(last + 1) as string[];

  // JavaScript and Rust print the error above the frames; Python prints it below them.
  let head: string | undefined;
  const firstAfter = after.findIndex((entry) => entry.trim() !== "");
  // Go prints goroutine headers between the panic and its frames, so a line that names an error wins.
  const named = before.findLastIndex((entry) => HEAD.test(entry.trim()));
  const lastBefore = named >= 0 ? named : before.findLastIndex((entry) => entry.trim() !== "");
  if (python && firstAfter >= 0) head = after.splice(firstAfter, 1)[0];
  else if (lastBefore >= 0) head = before.splice(lastBefore, 1)[0];
  else if (firstAfter >= 0) head = after.splice(firstAfter, 1)[0];

  const trimEnds = (block: string[]) => {
    while (block.length && !block[0]?.trim()) block.shift();
    while (block.length && !block.at(-1)?.trim()) block.pop();
    return block;
  };
  const split = HEAD.exec(head?.trim() ?? "");
  return {
    before: trimEnds(before),
    ...(split?.[1] ? { errorType: split[1] } : {}),
    message: split?.[1] ? (split[2] ?? "") : (head?.trim() ?? ""),
    frames,
    after: trimEnds(after),
  };
}

function FrameText({ frame, links }: { frame: StackFrame; links: FileLinks | undefined }) {
  const at = frame.location;
  if (!at) return <>{frame.text}</>;
  const label = frame.text.slice(at.start, at.end);
  const target = links?.resolve(`${at.file}:${at.line}${at.column ? `:${at.column}` : ""}`);
  return (
    <>
      {frame.text.slice(0, at.start)}
      {target && links ? (
        <button className="trace-link" type="button" title={`Open ${target.path}`} onClick={() => links.open(target)}>
          {label}
        </button>
      ) : (
        <span className="trace-path">{label}</span>
      )}
      {frame.text.slice(at.end)}
    </>
  );
}

/**
 * A stack trace with its error first and its frames folded away. Library frames are dimmed, and frames
 * in the worktree open their file at the line.
 */
export function StackTrace({
  trace,
  text,
  links,
}: {
  trace: ParsedTrace;
  /** The original text, which the copy button copies whole. */
  text: string;
  links?: FileLinks | undefined;
}) {
  const [open, setOpen] = useState(false);
  const count = trace.frames.length;
  return (
    <div className="trace">
      {trace.before.length ? <pre className="trace-text">{trace.before.join("\n")}</pre> : null}
      {trace.errorType || trace.message ? (
        <p className="trace-head">
          {trace.errorType ? <span className="trace-type">{trace.errorType}</span> : null}
          {trace.errorType && trace.message ? ": " : null}
          {trace.message}
        </p>
      ) : null}
      <button className="trace-toggle" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="chevronRight" size={10} className="trace-chevron" />
        {count} {count === 1 ? "frame" : "frames"}
      </button>
      {open ? (
        <ol className="trace-frames">
          {trace.frames.map((entry, index) => (
            // Frames repeat in recursive traces, so their place is the only stable key.
            // biome-ignore lint/suspicious/noArrayIndexKey: the list never reorders.
            <li className={cx("trace-frame", entry.vendor && "is-vendor")} key={index}>
              <FrameText frame={entry} links={links} />
              {entry.code ? <span className="trace-code">{entry.code}</span> : null}
            </li>
          ))}
        </ol>
      ) : null}
      {trace.after.length ? <pre className="trace-text">{trace.after.join("\n")}</pre> : null}
      <CopyButton text={text} className="trace-copy" />
    </div>
  );
}

/** Error text that shows as a folded stack trace when it holds one, and as plain text otherwise. */
export function ErrorText({ text, links }: { text: string; links?: FileLinks | undefined }): ReactNode {
  const trace = parseStackTrace(text);
  return trace ? <StackTrace trace={trace} text={text} links={links} /> : text;
}
