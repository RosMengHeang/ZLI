import { open, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { StringDecoder } from "node:string_decoder";

import { type HistoryFolder, type HistorySource, MAX_HISTORY_SESSIONS } from "@zli-v2/contracts";

/** The folder is near the top of a session file; reading past this would mean the file is not a session. */
const MAX_HEAD_BYTES = 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;

type Transcript = { source: HistorySource; path: string; mtimeMs: number };

export type AgentHistoryScannerOptions = {
  home: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
};

/**
 * Finds the folders the person ran Claude Code and Codex in, from the agents' session files. It reads
 * only the start of each file and never changes them. Each file's folder is kept by modified time, so
 * a second scan reads only what changed.
 */
export class AgentHistoryScanner {
  private readonly cache = new Map<string, { mtimeMs: number; cwd: string | undefined }>();

  constructor(private readonly options: AgentHistoryScannerOptions) {}

  /** Folders that still exist, the most recently used first. */
  async scan(): Promise<HistoryFolder[]> {
    const transcripts = (await this.transcripts())
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .slice(0, MAX_HISTORY_SESSIONS);
    const folders = new Map<string, { path: string; lastActiveMs: number; sources: Set<HistorySource> }>();
    for (const transcript of transcripts) {
      const cwd = await this.cwdOf(transcript);
      if (!cwd) continue;
      const folderKey = this.folderKey(cwd);
      const folder = folders.get(folderKey) ?? { path: cwd, lastActiveMs: 0, sources: new Set() };
      folder.lastActiveMs = Math.max(folder.lastActiveMs, transcript.mtimeMs);
      folder.sources.add(transcript.source);
      folders.set(folderKey, folder);
    }
    const out: HistoryFolder[] = [];
    for (const folder of [...folders.values()].sort((left, right) => right.lastActiveMs - left.lastActiveMs)) {
      const exists = await stat(folder.path).then(
        (info) => info.isDirectory(),
        () => false,
      );
      if (!exists) continue;
      out.push({
        path: folder.path,
        name: basename(folder.path.replace(/[\\/]+$/u, "")) || folder.path,
        lastActiveAt: new Date(folder.lastActiveMs).toISOString(),
        sources: [...folder.sources],
      });
    }
    return out;
  }

  private folderKey(path: string): string {
    const trimmed = path.replace(/[\\/]+$/u, "").replace(/\\/gu, "/");
    return (this.options.platform ?? process.platform) === "win32" ? trimmed.toLowerCase() : trimmed;
  }

  private async cwdOf(transcript: Transcript): Promise<string | undefined> {
    const cached = this.cache.get(transcript.path);
    if (cached && cached.mtimeMs === transcript.mtimeMs) return cached.cwd;
    const cwd = await readCwd(transcript).catch(() => undefined);
    this.cache.set(transcript.path, { mtimeMs: transcript.mtimeMs, cwd });
    return cwd;
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
}

/** The folder one JSONL record says the session ran in, if it says. */
export function recordCwd(source: HistorySource, line: string): string | undefined {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!record || typeof record !== "object") return undefined;
  const value = record as Record<string, unknown>;
  if (source === "claude-code") return text(value.cwd);
  if (value.type !== "session_meta" && value.type !== "turn_context") return undefined;
  const payload = value.payload;
  return payload && typeof payload === "object" ? text((payload as Record<string, unknown>).cwd) : undefined;
}

/** Reads whole lines from the top of the file until one names the folder. */
async function readCwd(transcript: Transcript): Promise<string | undefined> {
  const file = await open(transcript.path, "r");
  try {
    let pending = "";
    let offset = 0;
    const buffer = Buffer.alloc(CHUNK_BYTES);
    const decoder = new StringDecoder("utf8");
    while (offset < MAX_HEAD_BYTES) {
      const { bytesRead } = await file.read(buffer, 0, CHUNK_BYTES, offset);
      const done = bytesRead === 0;
      offset += bytesRead;
      pending += done ? decoder.end() : decoder.write(buffer.subarray(0, bytesRead));
      const lines = pending.split("\n");
      pending = done ? "" : (lines.pop() ?? "");
      for (const line of lines) {
        const cwd = line.trim() ? recordCwd(transcript.source, line) : undefined;
        if (cwd) return cwd;
      }
      if (done) return undefined;
    }
    return undefined;
  } finally {
    await file.close();
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

async function list(dir: string): Promise<string[]> {
  return readdir(dir).catch(() => []);
}

async function describe(source: HistorySource, path: string): Promise<Transcript | undefined> {
  const info = await stat(path).catch(() => undefined);
  return info?.isFile() ? { source, path, mtimeMs: info.mtimeMs } : undefined;
}
