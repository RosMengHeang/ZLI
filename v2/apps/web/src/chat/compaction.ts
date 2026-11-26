import type {
  ThreadMessageProjection,
  ThreadProjection,
  ThreadTurnProjection,
  ThreadUsageRecord,
} from "@zli-v2/contracts";

import { movedText } from "../sessions/handoff.js";
import type { ContextUsage } from "../usage/usage.js";

/**
 * Compacting a chat: the agent swaps the conversation it carries for a short summary, so the next turns
 * start with room in the context window.
 *
 * Native: the agent's CLI compacts its own session when it gets "/compact" (the server reports it as
 * `capabilities.compaction`, and maps it to the agent's own name for it). Everything else: ZLI asks the agent
 * for a summary as one turn, then carries the chat on in a fresh session of the same agent and model, which
 * reads the summary instead of the full history.
 *
 *   agent                    native command   focus text after it
 *   claude-code              /compact         yes
 *   codex                    /compact         no (thread/compact/start)
 *   copilot, kimi            /compact         yes
 *   qwen                     /compress        yes (the server sends /compress)
 *   grok, goose, opencode    /compact         no
 *   gemini, cursor-agent,    none             summary way; the focus goes into ZLI's summary request
 *   droid, anything else
 *
 * "/compact keep the API decisions" passes its focus on where the agent takes one (`compactionInstructions`).
 */
export const COMPACT_COMMAND = "/compact";

/** The focus automatic compacting asks for, where the agent takes one. */
export const DEFAULT_COMPACT_FOCUS = "Keep the current task, decisions made, files changed and open questions.";

/** The first line of ZLI's summary request. It marks the request so the chat shows a divider instead. */
export const SUMMARY_REQUEST_HEAD = "Compact this conversation:";

export const SUMMARY_REQUEST = [
  `${SUMMARY_REQUEST_HEAD} write a summary that a fresh session of you can continue from, without the messages above.`,
  "Cover what the person asked for, what was decided and why, the files changed, where the work stands, and what is left to do. Keep exact names, paths, commands, and errors. Use short sections with plain headings.",
  "Reply with the summary only. Do not change any files or run anything.",
].join("\n\n");

/** Default for automatic compacting: once a finished turn leaves the context this full. */
export const DEFAULT_AUTO_COMPACT_AT = 0.85;
export const AUTO_COMPACT_AT_CHOICES: readonly number[] = [0.7, 0.8, 0.85, 0.9];

export type CompactionMode = "native" | "summary";

export function compactionMode(thread: Pick<ThreadProjection, "capabilities">): CompactionMode {
  return thread.capabilities.compaction === "native" ? "native" : "summary";
}

const COMPACT_PATTERN = /^\/compact(?:\s+([\s\S]*))?$/iu;

/** "/compact", alone or with focus text after it. */
export function isCompactCommand(text: string): boolean {
  return COMPACT_PATTERN.test(text.trim());
}

/** The focus text after "/compact", if any. */
export function compactFocus(text: string): string | undefined {
  return COMPACT_PATTERN.exec(text.trim())?.[1]?.trim() || undefined;
}

/** Whether this chat's way of compacting can carry focus text. ZLI's own summary request always can. */
export function takesCompactFocus(thread: Pick<ThreadProjection, "capabilities">): boolean {
  return compactionMode(thread) === "summary" || thread.capabilities.compactionInstructions === true;
}

/** What the chat sends to compact: the agent's "/compact" or ZLI's summary request, with the focus where it fits. */
export function compactRequestText(thread: Pick<ThreadProjection, "capabilities">, focus: string | undefined): string {
  const kept = focus && takesCompactFocus(thread) ? focus : undefined;
  if (compactionMode(thread) === "summary") {
    return kept ? `${SUMMARY_REQUEST}\n\nPay most attention to this: ${kept}` : SUMMARY_REQUEST;
  }
  return kept ? `${COMPACT_COMMAND} ${kept}` : COMPACT_COMMAND;
}

export function isCompactionRequest(message: ThreadMessageProjection): boolean {
  return (
    message.role === "user" &&
    (isCompactCommand(message.text) || message.text.trimStart().startsWith(SUMMARY_REQUEST_HEAD))
  );
}

/** One compaction in a chat, as the divider in its place shows it. */
export type Compaction = {
  /** The request's message id. */
  requestId: string;
  mode: CompactionMode;
  /** The agent's summary, for the summary way. Native compaction keeps its summary inside the agent. */
  summary?: string;
  /** What the agent said while it compacted natively. It goes into the divider, never into a reply. */
  reply?: string;
  /** A native compaction that ended normally but compacted nothing, or said it failed. */
  outcome?: "skipped" | "failed";
  /** The agent's own words for a skipped or failed compaction. */
  detail?: string;
};

// Agents report a no-op or a failure in an ordinary reply. The patterns follow Orca's OMP and Hermes
// dialects; the /compress wording covers Qwen Code, which inherits Gemini CLI's command.
const COMPACT_SKIPPED =
  /\b(?:nothing to (?:compact|compress)|already (?:compacted|compressed)|no changes from compression|compression refused|compression was not beneficial)\b/iu;
const COMPACT_FAILED =
  /\b(?:compaction|compression) (?:failed|aborted)\b|\bfailed to (?:compact|compress)\b|\bdoes not take focus instructions\b/iu;
// A real summary can use these words; only a short reply is a status line.
const STATUS_REPLY_MAX = 500;

/** What a normally ended native compaction's reply says about it. Undefined means it compacted. */
export function compactionReply(text: string): { outcome: "skipped" | "failed"; detail: string } | undefined {
  const reply = text.trim();
  if (!reply || reply.length > STATUS_REPLY_MAX) return undefined;
  if (COMPACT_SKIPPED.test(reply)) {
    return { outcome: "skipped", detail: reply.replace(/^(?:compaction|compression) failed:\s*/iu, "") };
  }
  return COMPACT_FAILED.test(reply) ? { outcome: "failed", detail: reply } : undefined;
}

const NOTICE_PREFIX = "compact:";
const notices = new WeakMap<ThreadMessageProjection, ThreadMessageProjection>();

/** The divider's stand-in message. The same request gives the same object, so the timeline keeps its rows. */
function noticeFor(request: ThreadMessageProjection): ThreadMessageProjection {
  const known = notices.get(request);
  if (known) return known;
  const notice: ThreadMessageProjection = {
    messageId: `${NOTICE_PREFIX}${request.messageId}`,
    threadId: request.threadId,
    role: "system",
    text: "Compacted",
  };
  notices.set(request, notice);
  return notice;
}

export function isCompactionNotice(message: ThreadMessageProjection): boolean {
  return message.role === "system" && message.messageId.startsWith(NOTICE_PREFIX);
}

export function compactionRequestId(notice: ThreadMessageProjection): string {
  return notice.messageId.slice(NOTICE_PREFIX.length);
}

/**
 * The thread's messages as the chat shows them: each compaction request becomes a divider, and the reply that
 * answered it (the summary, or what the agent said while compacting natively) moves into that divider.
 */
export function foldCompactions(messages: readonly ThreadMessageProjection[]): {
  messages: readonly ThreadMessageProjection[];
  compactions: ReadonlyMap<string, Compaction>;
} {
  if (!messages.some(isCompactionRequest)) return { messages, compactions: new Map() };
  const shown: ThreadMessageProjection[] = [];
  const compactions = new Map<string, Compaction>();
  let replyTo: Compaction | undefined;
  for (const message of messages) {
    if (isCompactionRequest(message)) {
      const mode: CompactionMode = isCompactCommand(message.text) ? "native" : "summary";
      const compaction: Compaction = { requestId: message.messageId, mode };
      compactions.set(message.messageId, compaction);
      shown.push(noticeFor(message));
      replyTo = compaction;
      continue;
    }
    // The summary way's reply is the summary. A native compaction's reply is only what the agent said doing it.
    if (replyTo && message.role === "assistant") {
      const key = replyTo.mode === "summary" ? "summary" : "reply";
      const known = replyTo[key];
      replyTo[key] = known ? `${known}\n\n${message.text}` : message.text;
      continue;
    }
    replyTo = undefined;
    shown.push(message);
  }
  for (const compaction of compactions.values()) {
    const said = compaction.reply === undefined ? undefined : compactionReply(compaction.reply);
    if (said) Object.assign(compaction, said);
  }
  return { messages: shown, compactions };
}

/** The latest summary in a chat's earlier threads, and the messages written after it, oldest first. */
export function latestSummary(
  messages: readonly ThreadMessageProjection[],
): { summary: string; after: readonly ThreadMessageProjection[] } | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user" || !message.text.trimStart().startsWith(SUMMARY_REQUEST_HEAD)) continue;
    let end = index + 1;
    const parts: string[] = [];
    while (messages[end]?.role === "assistant") {
      parts.push(messages[end]?.text ?? "");
      end += 1;
    }
    const summary = parts.join("\n\n").trim();
    if (!summary) return undefined;
    return { summary, after: messages.slice(end) };
  }
  return undefined;
}

const SINCE_SUMMARY_CHAR_BUDGET = 40_000;

/** What the fresh session reads before the person's next message: the summary, then anything said since. */
export function summaryContext(input: {
  summary: string;
  after: readonly ThreadMessageProjection[];
  branch: string;
  /** The branch the chat was on before the person moved it to this folder. */
  movedFrom?: string | undefined;
  nameOf(message: ThreadMessageProjection): string;
}): string {
  const said = input.after
    .filter((message) => (message.role === "user" || message.role === "assistant") && message.text.trim())
    .map((message) => `## ${message.role === "user" ? "User" : input.nameOf(message)}\n\n${message.text.trim()}`);
  // The newest messages since the summary, within the same room a takeover gets.
  const later: string[] = [];
  let room = SINCE_SUMMARY_CHAR_BUDGET;
  for (let index = said.length - 1; index >= 0 && room > 0; index -= 1) {
    const part = said[index] ?? "";
    later.unshift(part.length > room ? `${part.slice(0, room)}…` : part);
    room -= part.length;
  }
  return [
    `This chat was compacted to save context. You wrote the summary below in an earlier session. You now work ${movedText(input.branch, input.movedFrom)} Carry on from it. Files may have changed since, so check them before you rely on it. Then answer the person's new message, which follows.`,
    `<summary>\n${input.summary}\n</summary>`,
    ...(later.length > 0 ? [`<since-the-summary>\n${later.join("\n\n")}\n</since-the-summary>`] : []),
    "The person's new message:",
  ].join("\n\n");
}

/**
 * Context windows of models whose agents do not always report one, from the providers' model pages. Only
 * used when the agent's own report leaves the window out.
 */
const KNOWN_WINDOWS: ReadonlyArray<readonly [RegExp, number]> = [
  [/\[1m\]$/iu, 1_000_000],
  [/^(claude-)?(opus|sonnet|haiku)|^claude-/iu, 200_000],
  [/^gemini-(2\.5|3)/iu, 1_048_576],
  [/^kimi-k2/iu, 262_144],
  [/^grok-4|^grok-code-fast/iu, 256_000],
];

export function knownContextWindow(model: string | undefined): number | undefined {
  if (!model) return undefined;
  return KNOWN_WINDOWS.find(([pattern]) => pattern.test(model))?.[1];
}

/** The context the meter shows: the agent's own window when it reports one, else the model's known window. */
export function withKnownWindow(
  context: ContextUsage | undefined,
  model: string | undefined,
): ContextUsage | undefined {
  if (!context || context.window) return context;
  const window = knownContextWindow(model);
  return window ? { ...context, window } : context;
}

/** Whether a turn that just ended should be followed by a compaction. */
export function shouldAutoCompact(input: {
  enabled: boolean;
  threshold: number;
  context: ContextUsage | undefined;
  idle: boolean;
  /** Messages waiting to go, an open request, or a compaction already under way. */
  busy: boolean;
  /** The latest message in the thread is already a compaction request or its summary. */
  justCompacted: boolean;
}): boolean {
  const { context } = input;
  if (!input.enabled || !input.idle || input.busy || input.justCompacted || !context?.window) return false;
  return context.tokens / context.window >= input.threshold;
}

/** The latest request or reply in the thread is a compaction, so another one would compact nothing. */
export function endsWithCompaction(messages: readonly ThreadMessageProjection[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role === "system") continue;
    if (isCompactionRequest(message)) return true;
    if (message.role === "assistant") {
      const ask = messages.slice(0, index).findLast((earlier) => earlier.role === "user");
      return ask ? isCompactionRequest(ask) : false;
    }
    return false;
  }
  return false;
}

/**
 * Tokens a native compaction freed: the context before its turn less the context its turn reported. The
 * compaction request is the nth message sent to the thread, so it ran as the thread's nth turn.
 */
export function nativeTokensSaved(input: {
  requestId: string;
  messages: readonly ThreadMessageProjection[];
  turns: readonly ThreadTurnProjection[];
  usage: readonly ThreadUsageRecord[];
}): number | undefined {
  const sent = input.messages.filter((message) => message.role === "user" || message.role === "agent");
  const position = sent.findIndex((message) => message.messageId === input.requestId);
  const turn = position >= 0 ? sortedTurns(input.turns)[position] : undefined;
  if (!turn) return undefined;
  const startedAt = Date.parse(turn.startedAt);
  let before: number | undefined;
  let after: number | undefined;
  for (const record of input.usage) {
    const tokens = record.usage.contextTokens;
    const at = record.recordedAt ? Date.parse(record.recordedAt) : Number.NaN;
    if (tokens === undefined || Number.isNaN(at)) continue;
    if (at < startedAt) before = tokens;
    else if (after === undefined) after = tokens;
  }
  return before !== undefined && after !== undefined && before > after ? before - after : undefined;
}

function sortedTurns(turns: readonly ThreadTurnProjection[]): ThreadTurnProjection[] {
  return [...turns].sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt));
}

/**
 * Tokens the summary way freed: the old session's last context less what the fresh one starts from, or an
 * estimate of the summary's size (about four characters a token) before the fresh session reports.
 */
export function summaryTokensSaved(input: {
  before: number | undefined;
  freshContext: number | undefined;
  summary: string | undefined;
}): number | undefined {
  if (input.before === undefined) return undefined;
  const after = input.freshContext ?? (input.summary ? Math.ceil(input.summary.length / 4) : undefined);
  return after !== undefined && input.before > after ? input.before - after : undefined;
}
