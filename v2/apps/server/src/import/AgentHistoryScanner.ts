import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import { type HistoryChat, type HistoryFolder, type HistorySource, MAX_HISTORY_CHATS } from "@zli-v2/contracts";

import {
  type ParsedHistoryChat,
  parseClaudeTranscript,
  parseCodexThreadNames,
  parseCodexTranscript,
} from "./agentHistory.js";

/** Transcripts larger than this are mostly tool output; reading them would stall the scan. */
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

type Transcript = { source: HistorySource; path: string; mtimeMs: number; size: number };
type Parsed = { chat: ParsedHistoryChat; transcript: Transcript };

export type AgentHistoryScannerOptions = {
  home: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
};

/**
 * Finds the person's past Claude Code and Codex chats on disk. It only reads the agents' files and
 * never changes them. Parsed transcripts are kept by file identity, so an import right after a scan
 * does not read the file twice.
 */
export class AgentHistoryScanner {
  private readonly cache = new Map<string, { mtimeMs: number; size: number; chat: ParsedHistoryChat | null }>();
  private readonly located = new Map<string, Transcript>();

  constructor(private readonly options: AgentHistoryScannerOptions) {}

  /** Groups the newest chats by the folder they ran in. `importedIds` marks chats already in ZLI. */
  async scan(importedIds: ReadonlySet<string>): Promise<HistoryFolder[]> {
    const transcripts = (await this.transcripts())
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .slice(0, MAX_HISTORY_CHATS);
    const names = await this.codexNames();
    const parsed: Parsed[] = [];
    for (const transcript of transcripts) {
      const chat = await this.parse(transcript, names);
      if (!chat) continue;
      this.located.set(key(chat.source, chat.providerSessionId), transcript);
      parsed.push({ chat, transcript });
    }
    return this.group(parsed, importedIds);
  }

  /** The full chat behind a scan row, read again if its file changed since the scan. */
  async load(source: HistorySource, providerSessionId: string): Promise<ParsedHistoryChat | undefined> {
    let transcript = this.located.get(key(source, providerSessionId));
    if (!transcript) {
      await this.scan(new Set());
      transcript = this.located.get(key(source, providerSessionId));
    }
    if (!transcript) return undefined;
    const info = await stat(transcript.path).catch(() => undefined);
    if (!info) return undefined;
    const fresh = { ...transcript, mtimeMs: info.mtimeMs, size: info.size };
    const chat = await this.parse(fresh, await this.codexNames());
    return chat?.providerSessionId === providerSessionId
      ? { ...chat, lastActiveAt: new Date(info.mtimeMs).toISOString() }
      : undefined;
  }

  private async group(parsed: readonly Parsed[], importedIds: ReadonlySet<string>): Promise<HistoryFolder[]> {
    const folders = new Map<string, { path: string; chats: HistoryChat[]; lastActiveMs: number }>();
    for (const { chat, transcript } of parsed) {
      const folderKey = this.folderKey(chat.cwd);
      const folder = folders.get(folderKey) ?? { path: chat.cwd, chats: [], lastActiveMs: 0 };
      folder.chats.push({
        source: chat.source,
        providerSessionId: chat.providerSessionId,
        title: chat.title || "Untitled chat",
        ...(chat.model ? { model: chat.model } : {}),
        messageCount: chat.messages.length + chat.omitted,
        lastActiveAt: new Date(transcript.mtimeMs).toISOString(),
        ...(importedIds.has(chat.providerSessionId) ? { imported: true } : {}),
      });
      folder.lastActiveMs = Math.max(folder.lastActiveMs, transcript.mtimeMs);
      folders.set(folderKey, folder);
    }
    const out: HistoryFolder[] = [];
    for (const folder of [...folders.values()].sort((left, right) => right.lastActiveMs - left.lastActiveMs)) {
      const exists = await stat(folder.path).then(
        (info) => info.isDirectory(),
        () => false,
      );
      out.push({
        path: folder.path,
        name: basename(folder.path.replace(/[\\/]+$/u, "")) || folder.path,
        exists,
        lastActiveAt: new Date(folder.lastActiveMs).toISOString(),
        chats: folder.chats.sort((left, right) => right.lastActiveAt.localeCompare(left.lastActiveAt)),
      });
    }
    return out;
  }

  private folderKey(path: string): string {
    const trimmed = path.replace(/[\\/]+$/u, "").replace(/\\/gu, "/");
    return (this.options.platform ?? process.platform) === "win32" ? trimmed.toLowerCase() : trimmed;
  }

  private async parse(transcript: Transcript, names: ReadonlyMap<string, string>): Promise<ParsedHistoryChat | null> {
    const cached = this.cache.get(transcript.path);
    if (cached && cached.mtimeMs === transcript.mtimeMs && cached.size === transcript.size) return cached.chat;
    if (transcript.size > MAX_TRANSCRIPT_BYTES) return null;
    let chat: ParsedHistoryChat | null = null;
    try {
      const contents = await readFile(transcript.path, "utf8");
      chat =
        transcript.source === "claude-code"
          ? parseClaudeTranscript(contents, basename(transcript.path, ".jsonl"))
          : parseCodexTranscript(contents, names);
    } catch {
      chat = null;
    }
    this.cache.set(transcript.path, { mtimeMs: transcript.mtimeMs, size: transcript.size, chat });
    return chat;
  }

  private async transcripts(): Promise<Transcript[]> {
    const [claude, codex] = await Promise.all([this.claudeTranscripts(), this.codexTranscripts()]);
    return [...claude, ...codex];
  }

  private claudeHome(): string {
    return this.options.env?.CLAUDE_CONFIG_DIR?.trim() || join(this.options.home, ".claude");
  }

  private codexHome(): string {
    return this.options.env?.CODEX_HOME?.trim() || join(this.options.home, ".codex");
  }

  /** Top-level files only: sub-agent transcripts live in folders beside them. */
  private async claudeTranscripts(): Promise<Transcript[]> {
    const root = join(this.claudeHome(), "projects");
    const out: Transcript[] = [];
    for (const folder of await list(root)) {
      const dir = join(root, folder);
      for (const file of await list(dir)) {
        if (!file.endsWith(".jsonl")) continue;
        const found = await describe("claude-code", join(dir, file));
        if (found) out.push(found);
      }
    }
    return out;
  }

  private async codexTranscripts(): Promise<Transcript[]> {
    const root = join(this.codexHome(), "sessions");
    const out: Transcript[] = [];
    for (const year of await list(root)) {
      for (const month of await list(join(root, year))) {
        for (const day of await list(join(root, year, month))) {
          const dir = join(root, year, month, day);
          for (const file of await list(dir)) {
            if (!file.startsWith("rollout-") || !file.endsWith(".jsonl")) continue;
            const found = await describe("codex", join(dir, file));
            if (found) out.push(found);
          }
        }
      }
    }
    return out;
  }

  private async codexNames(): Promise<Map<string, string>> {
    const contents = await readFile(join(this.codexHome(), "session_index.jsonl"), "utf8").catch(() => "");
    return parseCodexThreadNames(contents);
  }
}

function key(source: HistorySource, providerSessionId: string): string {
  return `${source}:${providerSessionId}`;
}

async function list(dir: string): Promise<string[]> {
  return readdir(dir).catch(() => []);
}

async function describe(source: HistorySource, path: string): Promise<Transcript | undefined> {
  const info = await stat(path).catch(() => undefined);
  return info?.isFile() ? { source, path, mtimeMs: info.mtimeMs, size: info.size } : undefined;
}
