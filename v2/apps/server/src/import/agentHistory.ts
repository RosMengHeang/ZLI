import { type HistorySource, MAX_IMPORTED_MESSAGES } from "@zli-v2/contracts";

/** A past chat read from an agent CLI's transcript, before it becomes a ZLI chat. */
export type ParsedHistoryChat = {
  source: HistorySource;
  providerSessionId: string;
  cwd: string;
  title: string;
  model?: string;
  createdAt: string;
  /** When the transcript last changed, set by the scanner. */
  lastActiveAt?: string;
  messages: { role: "user" | "assistant"; text: string }[];
  /** Messages dropped from the start so the rest fit the import limit. */
  omitted: number;
};

const MAX_TITLE = 80;

type JsonRecord = Record<string, unknown>;

function records(contents: string): JsonRecord[] {
  const out: JsonRecord[] = [];
  for (const line of contents.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === "object" && !Array.isArray(value)) out.push(value as JsonRecord);
    } catch {
      // A line cut off while the CLI was still writing it is skipped.
    }
  }
  return out;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function iso(value: unknown): string | undefined {
  const text = str(value);
  if (!text) return undefined;
  const time = Date.parse(text);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

function textBlocks(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => {
      if (!block || typeof block !== "object") return [];
      const { type, text } = block as JsonRecord;
      return (type === "text" || type === "input_text" || type === "output_text") && typeof text === "string"
        ? [text]
        : [];
    })
    .join("\n");
}

/** Context the CLI adds to a prompt for the model, which the person never typed. */
function stripInjected(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gu, "").trim();
}

/** Slash commands, their output, and interrupt markers are bookkeeping, not part of the conversation. */
function isClaudeBookkeeping(text: string): boolean {
  return (
    /^<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat)>/u.test(
      text,
    ) ||
    text.startsWith("Caveat: The messages below were generated") ||
    /^\[Request interrupted by user/u.test(text)
  );
}

export function titleFrom(text: string): string {
  const line =
    text
      .split("\n")
      .find((candidate) => candidate.trim())
      ?.trim() ?? "";
  const flat = line.replace(/\s+/gu, " ");
  return flat.length > MAX_TITLE ? `${flat.slice(0, MAX_TITLE - 1).trimEnd()}…` : flat;
}

class MessageLog {
  readonly messages: ParsedHistoryChat["messages"] = [];
  private pending: string[] = [];

  user(text: string): void {
    this.flush();
    this.messages.push({ role: "user", text });
  }

  /** Replies arrive in several records per turn; they become one message. */
  assistant(text: string): void {
    this.pending.push(text);
  }

  done(): { messages: ParsedHistoryChat["messages"]; omitted: number } {
    this.flush();
    const omitted = Math.max(0, this.messages.length - MAX_IMPORTED_MESSAGES);
    return { messages: this.messages.slice(omitted), omitted };
  }

  private flush(): void {
    if (this.pending.length === 0) return;
    this.messages.push({ role: "assistant", text: this.pending.join("\n\n") });
    this.pending = [];
  }
}

/**
 * Reads a Claude Code transcript (`~/.claude/projects/<folder>/<session>.jsonl`). Side chats from
 * sub-agents, meta records, compaction summaries, and tool calls stay out; the text the person and
 * Claude wrote stays in.
 */
export function parseClaudeTranscript(contents: string, fallbackSessionId: string): ParsedHistoryChat | null {
  const log = new MessageLog();
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let createdAt: string | undefined;
  let model: string | undefined;
  let customTitle: string | undefined;
  let aiTitle: string | undefined;
  let firstUser: string | undefined;
  for (const record of records(contents)) {
    createdAt ??= iso(record.timestamp);
    if (record.type === "custom-title" && typeof record.customTitle === "string") {
      // An empty rename clears the title.
      customTitle = str(record.customTitle);
      continue;
    }
    if (record.type === "ai-title" || typeof record.aiTitle === "string") {
      aiTitle = str(record.aiTitle) ?? aiTitle;
      continue;
    }
    if (record.type !== "user" && record.type !== "assistant") continue;
    if (record.isSidechain === true || record.isMeta === true || record.isCompactSummary === true) continue;
    sessionId = str(record.sessionId) ?? sessionId;
    cwd ??= str(record.cwd);
    const message = record.message as JsonRecord | undefined;
    if (!message) continue;
    const text = stripInjected(textBlocks(message.content));
    if (record.type === "assistant") {
      const name = str(message.model);
      // Claude writes this for replies it produced locally, such as errors; it cannot be resumed with.
      if (name && name !== "<synthetic>") model = name;
      if (text) log.assistant(text);
      continue;
    }
    if (!text || isClaudeBookkeeping(text)) continue;
    firstUser ??= text;
    log.user(text);
  }
  const id = sessionId ?? fallbackSessionId;
  if (!cwd || !firstUser || !id) return null;
  const { messages, omitted } = log.done();
  return {
    source: "claude-code",
    providerSessionId: id,
    cwd,
    title: titleFrom(customTitle ?? aiTitle ?? firstUser),
    ...(model ? { model } : {}),
    createdAt: createdAt ?? new Date(0).toISOString(),
    messages,
    omitted,
  };
}

/**
 * Reads a Codex rollout (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`). The `event_msg` records
 * hold what the person typed and what Codex said, without the context Codex adds for the model.
 */
export function parseCodexTranscript(contents: string, names: ReadonlyMap<string, string>): ParsedHistoryChat | null {
  // Rollouts carry the conversation twice: event messages as typed, and response items as sent to
  // the model. Some rollouts have only the second, so it is the fallback.
  const events = new MessageLog();
  const items = new MessageLog();
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let createdAt: string | undefined;
  let model: string | undefined;
  let firstEventUser: string | undefined;
  let firstItemUser: string | undefined;
  for (const record of records(contents)) {
    createdAt ??= iso(record.timestamp);
    const payload = record.payload as JsonRecord | undefined;
    if (!payload) continue;
    if (record.type === "session_meta") {
      sessionId ??= str(payload.id) ?? str(payload.session_id);
      cwd ??= str(payload.cwd);
      continue;
    }
    if (record.type === "turn_context") {
      model = str(payload.model) ?? model;
      continue;
    }
    if (record.type === "response_item" && payload.type === "message") {
      const text = textBlocks(payload.content).trim();
      if (!text) continue;
      if (payload.role === "user" && !CODEX_PREAMBLE.test(text)) {
        firstItemUser ??= text;
        items.user(text);
      } else if (payload.role === "assistant") {
        items.assistant(text);
      }
      continue;
    }
    if (record.type !== "event_msg") continue;
    const text = typeof payload.message === "string" ? payload.message.trim() : "";
    if (!text) continue;
    if (payload.type === "user_message") {
      firstEventUser ??= text;
      events.user(text);
    } else if (payload.type === "agent_message") {
      events.assistant(text);
    }
  }
  const firstUser = firstEventUser ?? firstItemUser;
  if (!sessionId || !cwd || !firstUser) return null;
  const { messages, omitted } = (firstEventUser ? events : items).done();
  return {
    source: "codex",
    providerSessionId: sessionId,
    cwd,
    title: titleFrom(names.get(sessionId) ?? firstUser),
    ...(model ? { model } : {}),
    createdAt: createdAt ?? new Date(0).toISOString(),
    messages,
    omitted,
  };
}

/** Context Codex sends as a user message ahead of the real request. */
const CODEX_PREAMBLE =
  /^(?:<(?:environment_context|user_instructions|INSTRUCTIONS|recommended_plugins|in-app-browser-context)[\s>]|# AGENTS\.md instructions\b)/u;

/** `session_index.jsonl` gets a line per rename; the newest nonempty name wins, as in Codex. */
export function parseCodexThreadNames(contents: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const record of records(contents)) {
    const id = str(record.id);
    const name = str(record.thread_name);
    if (id && name) names.set(id, name);
  }
  return names;
}
