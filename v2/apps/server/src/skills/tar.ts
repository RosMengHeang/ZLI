export type TarEntry = {
  path: string;
  type: "file" | "directory" | "link" | "other";
  size: number;
  /** Present for files the caller asked to keep. */
  data?: Uint8Array;
};

const BLOCK = 512;
const MAX_META_BYTES = 1024 * 1024;

type Current = {
  path: string;
  flag: string;
  size: number;
  received: number;
  collect: boolean;
  chunks: Buffer[];
};

/**
 * Reads a tar stream (ustar with pax and GNU long names, as GitHub produces) one chunk at a time, so only
 * the files the caller keeps are held in memory.
 */
export class TarReader {
  private pending: Buffer = Buffer.alloc(0);
  private skip = 0;
  private current: Current | undefined;
  private paxPath: string | undefined;
  private longName: string | undefined;
  private finished = false;

  constructor(
    private readonly options: {
      keep: (path: string, size: number) => boolean;
      onEntry: (entry: TarEntry) => void;
    },
  ) {}

  get done(): boolean {
    return this.finished;
  }

  push(chunk: Uint8Array): void {
    this.pending = this.pending.length > 0 ? Buffer.concat([this.pending, chunk]) : Buffer.from(chunk);
    while (!this.finished) {
      if (this.skip > 0) {
        const count = Math.min(this.skip, this.pending.length);
        this.pending = this.pending.subarray(count);
        this.skip -= count;
        if (this.skip > 0) return;
        continue;
      }
      if (this.current) {
        const current = this.current;
        const count = Math.min(current.size - current.received, this.pending.length);
        if (current.collect) current.chunks.push(Buffer.from(this.pending.subarray(0, count)));
        current.received += count;
        this.pending = this.pending.subarray(count);
        if (current.received < current.size) return;
        this.current = undefined;
        this.skip = padding(current.size);
        this.finish(current);
        continue;
      }
      if (this.pending.length < BLOCK) return;
      const header = this.pending.subarray(0, BLOCK);
      this.pending = this.pending.subarray(BLOCK);
      if (header.every((byte) => byte === 0)) {
        this.finished = true;
        return;
      }
      this.current = this.readHeader(header);
      if (this.current.size === 0) {
        const current = this.current;
        this.current = undefined;
        this.finish(current);
      }
    }
  }

  private readHeader(header: Buffer): Current {
    if (!checksumMatches(header)) throw new Error("The download is not a valid tar archive.");
    const flag = String.fromCharCode(header[156] ?? 0);
    const size = readSize(header.subarray(124, 136));
    const name = cString(header.subarray(0, 100));
    const prefix = header.subarray(257, 262).toString("latin1") === "ustar" ? cString(header.subarray(345, 500)) : "";
    const isMeta = flag === "x" || flag === "g" || flag === "L";
    let path = prefix ? `${prefix}/${name}` : name;
    if (!isMeta) {
      path = this.paxPath ?? this.longName ?? path;
      this.paxPath = undefined;
      this.longName = undefined;
    }
    if (isMeta && size > MAX_META_BYTES) throw new Error("The download has an oversized tar header.");
    const collect = flag === "x" || flag === "L" || (fileFlag(flag) && this.options.keep(path, size));
    return { path, flag, size, received: 0, collect, chunks: [] };
  }

  private finish(current: Current): void {
    const data = Buffer.concat(current.chunks);
    if (current.flag === "x") {
      this.paxPath = paxRecords(data).path;
      return;
    }
    if (current.flag === "L") {
      this.longName = cString(data);
      return;
    }
    if (current.flag === "g") return;
    const type = fileFlag(current.flag)
      ? "file"
      : current.flag === "5"
        ? "directory"
        : current.flag === "1" || current.flag === "2"
          ? "link"
          : "other";
    this.options.onEntry({
      path: current.path,
      type,
      size: current.size,
      ...(current.collect ? { data: new Uint8Array(data) } : {}),
    });
  }
}

function fileFlag(flag: string): boolean {
  return flag === "0" || flag === "\0" || flag === "7";
}

function padding(size: number): number {
  return (BLOCK - (size % BLOCK)) % BLOCK;
}

function cString(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return Buffer.from(end < 0 ? bytes : bytes.subarray(0, end)).toString("utf8");
}

function readSize(field: Buffer): number {
  if (((field[0] ?? 0) & 0x80) !== 0) {
    let value = 0;
    for (let index = 1; index < field.length; index += 1) value = value * 256 + (field[index] ?? 0);
    return value;
  }
  const text = field
    .toString("latin1")
    .replace(/[\0 ]+$/u, "")
    .trim();
  const value = text ? Number.parseInt(text, 8) : 0;
  if (!Number.isFinite(value) || value < 0) throw new Error("The download is not a valid tar archive.");
  return value;
}

function checksumMatches(header: Buffer): boolean {
  const stored = Number.parseInt(
    header
      .subarray(148, 156)
      .toString("latin1")
      .replace(/[\0 ]+/gu, ""),
    8,
  );
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) sum += index >= 148 && index < 156 ? 32 : (header[index] ?? 0);
  return stored === sum;
}

function paxRecords(data: Buffer): Record<string, string> {
  const records: Record<string, string> = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(32, offset);
    if (space < 0) break;
    const length = Number.parseInt(data.subarray(offset, space).toString("latin1"), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = data.subarray(space + 1, offset + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals > 0) records[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return records;
}
