import { createHash } from "node:crypto";
import { type Dirent, promises as fs } from "node:fs";
import { join, resolve } from "node:path";

import type {
  UsageDay,
  UsageModelRow,
  UsageProviderRow,
  UsageRange,
  UsageReport,
  UsageTokens,
} from "@zli-v2/contracts";

import { requestCost } from "./pricing.js";
import {
  CLAUDE_MARKERS,
  CODEX_MARKERS,
  type CodexState,
  initialCodexState,
  parseClaudeLine,
  parseCodexLine,
  type UsageEntry,
  type UsageProvider,
} from "./transcripts.js";

/** A folder of one agent's session logs: Claude Code's `projects`, Codex's `sessions`. */
export type UsageSource = { provider: UsageProvider; dir: string };

type FileState = {
  size: number;
  mtimeMs: number;
  /** Byte offset just past the last complete line read. */
  offset: number;
  /** A hash of the bytes just before `offset`; a file rewritten in place is read again from the start. */
  guard: string;
  entries: UsageEntry[];
  codex: CodexState | undefined;
};

const CHUNK_BYTES = 256 * 1024;
const GUARD_BYTES = 64;
const NEWLINE = 0x0a;
const READ_CONCURRENCY = 8;
const MAX_DAYS = 3_650;

/**
 * Token use and list cost from the agents' own session logs on this computer. Files are only read,
 * never written. Each file is remembered by size and modified time, and a file that only grew is read
 * from where the last read stopped, so asking again is cheap.
 */
export class UsageLog {
  private readonly files = new Map<string, FileState>();
  private scanning: Promise<{ entries: UsageEntry[]; files: number }> | undefined;

  constructor(
    private readonly options: {
      sources: () => readonly UsageSource[] | Promise<readonly UsageSource[]>;
      now?: () => number;
    },
  ) {}

  async read(range: UsageRange, timeZone?: string): Promise<UsageReport> {
    const zone = validZone(timeZone);
    const now = this.options.now?.() ?? Date.now();
    // Scans running together share one pass over the disk.
    this.scanning ??= this.scan().finally(() => {
      this.scanning = undefined;
    });
    const { entries, files } = await this.scanning;
    return aggregate(entries, { range, timeZone: zone, now, files });
  }

  private async scan(): Promise<{ entries: UsageEntry[]; files: number }> {
    const sources = dedupeSources(await this.options.sources());
    const listed: Array<{ path: string; provider: UsageProvider }> = [];
    for (const source of sources) {
      for (const path of await listLogs(source.dir)) listed.push({ path, provider: source.provider });
    }
    const seen = new Set(listed.map((file) => file.path));
    for (const path of this.files.keys()) if (!seen.has(path)) this.files.delete(path);

    const results: UsageEntry[][] = new Array(listed.length);
    let next = 0;
    const worker = async () => {
      while (next < listed.length) {
        const index = next++;
        const file = listed[index];
        if (file) results[index] = await this.readFile(file.path, file.provider);
      }
    };
    await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, listed.length) }, worker));
    return { entries: results.flat(), files: listed.length };
  }

  private async readFile(path: string, provider: UsageProvider): Promise<UsageEntry[]> {
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(path, "r");
    } catch {
      return this.files.get(path)?.entries ?? [];
    }
    try {
      const stat = await handle.stat();
      const known = this.files.get(path);
      if (known && known.size === stat.size && known.mtimeMs === stat.mtimeMs) return known.entries;
      const resume = known && stat.size >= known.offset && (await guardOf(handle, known.offset)) === known.guard;
      const start = resume ? known.offset : 0;
      const entries = resume ? [...known.entries] : [];
      const codex =
        provider === "codex" ? (structuredClone(resume ? known.codex : undefined) ?? initialCodexState()) : undefined;
      const markers = (provider === "codex" ? CODEX_MARKERS : CLAUDE_MARKERS).map((marker) => Buffer.from(marker));
      const parseLine = (line: Buffer, state: CodexState | undefined, into: UsageEntry[]) => {
        if (!markers.some((marker) => line.includes(marker))) return;
        const textLine = line.toString("utf8");
        into.push(...(state ? parseCodexLine(textLine, state) : parseClaudeLine(textLine)));
      };
      const { offset, tail } = await readLines(handle, start, (line) => parseLine(line, codex, entries));
      // A last line still being written is read for now but not remembered, so the next read sees it whole.
      const tailEntries: UsageEntry[] = [];
      if (tail.length > 0) parseLine(tail, structuredClone(codex), tailEntries);
      this.files.set(path, {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        offset,
        guard: await guardOf(handle, offset),
        entries,
        codex,
      });
      return tailEntries.length > 0 ? [...entries, ...tailEntries] : entries;
    } catch {
      return this.files.get(path)?.entries ?? [];
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
}

async function readLines(
  handle: fs.FileHandle,
  start: number,
  onLine: (line: Buffer) => void,
): Promise<{ offset: number; tail: Buffer }> {
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  let position = start;
  let offset = start;
  let pending: Buffer[] = [];
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, position);
    if (bytesRead === 0) break;
    const chunk = buffer.subarray(0, bytesRead);
    let lineStart = 0;
    for (;;) {
      const newline = chunk.indexOf(NEWLINE, lineStart);
      if (newline === -1) break;
      const piece = chunk.subarray(lineStart, newline);
      onLine(pending.length > 0 ? Buffer.concat([...pending, piece]) : piece);
      pending = [];
      lineStart = newline + 1;
      offset = position + lineStart;
    }
    // Copied, since the next read reuses the buffer.
    if (lineStart < chunk.length) pending.push(Buffer.from(chunk.subarray(lineStart)));
    position += bytesRead;
  }
  return { offset, tail: Buffer.concat(pending) };
}

async function guardOf(handle: fs.FileHandle, offset: number): Promise<string> {
  const length = Math.min(GUARD_BYTES, offset);
  if (length === 0) return "";
  const window = Buffer.alloc(length);
  const { bytesRead } = await handle.read(window, 0, length, offset - length);
  return createHash("sha1").update(window.subarray(0, bytesRead)).digest("hex");
}

async function listLogs(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number) => {
    if (depth > 8) return;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(path);
    }
  };
  await walk(root, 0);
  return found;
}

function dedupeSources(sources: readonly UsageSource[]): UsageSource[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = `${source.provider}:${resolve(source.dir).toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function validZone(timeZone: string | undefined): string {
  const fallback = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  if (!timeZone) return fallback;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone });
    return timeZone;
  } catch {
    return fallback;
  }
}

function dayFormatter(timeZone: string): (at: number) => string {
  const format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  return (at) => format.format(at);
}

/** The day `days` before a YYYY-MM-DD day, counted on the calendar. */
function shiftDay(day: string, days: number): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (date ?? 1) - days)).toISOString().slice(0, 10);
}

function emptyTokens(): UsageTokens {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}

export function tokenSum(tokens: UsageTokens): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
}

type Spend = { tokens: UsageTokens; costUsd: number; unpricedTokens: number; requests: number };

function emptySpend(): Spend {
  return { tokens: emptyTokens(), costUsd: 0, unpricedTokens: 0, requests: 0 };
}

function addSpend(into: Spend, entry: UsageEntry, cost: number | undefined): void {
  into.tokens.input += entry.input;
  into.tokens.output += entry.output;
  into.tokens.cacheRead += entry.cacheRead;
  into.tokens.cacheWrite += entry.cacheWrite;
  into.tokens.reasoning += entry.reasoning;
  into.requests += 1;
  if (cost === undefined) into.unpricedTokens += entry.input + entry.output + entry.cacheRead + entry.cacheWrite;
  else into.costUsd += cost;
}

/** Copies of one request keep each count's largest value; a reply's lines can grow as it streams. */
export function mergeCopies(entries: readonly UsageEntry[]): UsageEntry[] {
  const merged: UsageEntry[] = [];
  const byKey = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.key) {
      merged.push(entry);
      continue;
    }
    const index = byKey.get(entry.key);
    const held = index === undefined ? undefined : merged[index];
    if (index === undefined || !held) {
      byKey.set(entry.key, merged.length);
      merged.push(entry);
      continue;
    }
    merged[index] = {
      ...held,
      input: Math.max(held.input, entry.input),
      output: Math.max(held.output, entry.output),
      cacheRead: Math.max(held.cacheRead, entry.cacheRead),
      cacheWrite: Math.max(held.cacheWrite, entry.cacheWrite),
      cacheWrite1h: Math.max(held.cacheWrite1h, entry.cacheWrite1h),
      reasoning: Math.max(held.reasoning, entry.reasoning),
      at: Math.min(held.at, entry.at),
    };
  }
  return merged;
}

export function aggregate(
  entries: readonly UsageEntry[],
  options: { range: UsageRange; timeZone: string; now: number; files: number },
): UsageReport {
  const toDay = dayFormatter(options.timeZone);
  const today = toDay(options.now);
  const span = options.range === "7d" ? 7 : options.range === "30d" ? 30 : undefined;
  const firstAllowed = span === undefined ? undefined : shiftDay(today, span - 1);

  const totals = emptySpend();
  const providers = new Map<UsageProvider, Spend>();
  const models = new Map<string, Spend & { provider: UsageProvider; model: string; priced: boolean }>();
  const days = new Map<
    string,
    { tokens: number; costUsd: number; providers: Map<UsageProvider, { tokens: number; costUsd: number }> }
  >();

  for (const entry of mergeCopies(entries)) {
    const day = toDay(entry.at);
    if (firstAllowed !== undefined && day < firstAllowed) continue;
    if (day > today) continue;
    const cost = requestCost(entry.model, entry);
    addSpend(totals, entry, cost);

    const provider = providers.get(entry.provider) ?? emptySpend();
    addSpend(provider, entry, cost);
    providers.set(entry.provider, provider);

    const modelKey = `${entry.provider}\u0000${entry.model}`;
    const model = models.get(modelKey) ?? {
      ...emptySpend(),
      provider: entry.provider,
      model: entry.model,
      priced: true,
    };
    addSpend(model, entry, cost);
    if (cost === undefined) model.priced = false;
    models.set(modelKey, model);

    const tokens = entry.input + entry.output + entry.cacheRead + entry.cacheWrite;
    const bucket = days.get(day) ?? { tokens: 0, costUsd: 0, providers: new Map() };
    bucket.tokens += tokens;
    bucket.costUsd += cost ?? 0;
    const slice = bucket.providers.get(entry.provider) ?? { tokens: 0, costUsd: 0 };
    slice.tokens += tokens;
    slice.costUsd += cost ?? 0;
    bucket.providers.set(entry.provider, slice);
    days.set(day, bucket);
  }

  const earliest = [...days.keys()].sort()[0];
  const from = firstAllowed ?? earliest;
  const dayRows: UsageDay[] = [];
  if (from !== undefined) {
    // Every day in the range gets a row, so the chart shows quiet days as gaps.
    let start = from;
    if (shiftDay(today, MAX_DAYS - 1) > start) start = shiftDay(today, MAX_DAYS - 1);
    for (let day = start, guard = 0; day <= today && guard < MAX_DAYS; day = shiftDay(day, -1), guard++) {
      const bucket = days.get(day);
      dayRows.push({
        date: day,
        tokens: bucket?.tokens ?? 0,
        costUsd: bucket?.costUsd ?? 0,
        providers: bucket
          ? [...bucket.providers].map(([provider, slice]) => ({
              provider,
              tokens: slice.tokens,
              costUsd: slice.costUsd,
            }))
          : [],
      });
    }
  }

  const byWeight = (left: Spend, right: Spend) =>
    right.costUsd - left.costUsd || tokenSum(right.tokens) - tokenSum(left.tokens);
  const providerRows: UsageProviderRow[] = [...providers]
    .map(([provider, spend]) => ({ provider, ...spend }))
    .sort(byWeight);
  const modelRows: UsageModelRow[] = [...models.values()].sort(byWeight).slice(0, 300);

  return {
    range: options.range,
    timeZone: options.timeZone,
    ...(from !== undefined ? { from } : {}),
    to: today,
    days: dayRows,
    providers: providerRows,
    models: modelRows,
    totals,
    files: options.files,
    generatedAt: new Date(options.now).toISOString(),
  };
}
