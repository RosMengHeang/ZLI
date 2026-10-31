import { createWriteStream } from "node:fs";
import { chmod, type FileHandle, mkdir, open, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { createInflateRaw } from "node:zlib";

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const MAX_COMMENT = 0xffff;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IFDIR = 0o040000;

export type ZipEntry = {
  readonly name: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly localHeaderOffset: number;
  /** Unix mode bits when the archive was made on a Unix system. */
  readonly mode: number | undefined;
};

/** Finds the end-of-central-directory record in the last bytes of the archive. */
export function findEndOfCentralDirectory(tail: Buffer): { count: number; size: number; offset: number } {
  for (let index = tail.length - 22; index >= Math.max(0, tail.length - 22 - MAX_COMMENT); index -= 1) {
    if (tail.readUInt32LE(index) !== END_OF_CENTRAL_DIRECTORY) continue;
    const count = tail.readUInt16LE(index + 10);
    const size = tail.readUInt32LE(index + 12);
    const offset = tail.readUInt32LE(index + 16);
    if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff)
      throw new Error("Zip64 archives are not supported.");
    return { count, size, offset };
  }
  throw new Error("This file is not a zip archive.");
}

/** Reads the central directory, which lists every entry with sizes that local headers may leave out. */
export function parseCentralDirectory(directory: Buffer, count: number): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let cursor = 0;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > directory.length || directory.readUInt32LE(cursor) !== CENTRAL_FILE_HEADER)
      throw new Error("The zip archive's file list is damaged.");
    const madeBy = directory.readUInt16LE(cursor + 4) >> 8;
    const method = directory.readUInt16LE(cursor + 10);
    const compressedSize = directory.readUInt32LE(cursor + 20);
    const size = directory.readUInt32LE(cursor + 24);
    const nameLength = directory.readUInt16LE(cursor + 28);
    const extraLength = directory.readUInt16LE(cursor + 30);
    const commentLength = directory.readUInt16LE(cursor + 32);
    const external = directory.readUInt32LE(cursor + 38);
    const localHeaderOffset = directory.readUInt32LE(cursor + 42);
    const name = directory.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    const unixMode = external >>> 16;
    entries.push({
      name,
      method,
      compressedSize,
      size,
      localHeaderOffset,
      mode: madeBy === 3 && unixMode !== 0 ? unixMode : undefined,
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** The path an entry extracts to, or an error when it would land outside the destination. */
export function safeEntryPath(destination: string, name: string): string {
  const cleaned = name.replaceAll("\\", "/");
  if (cleaned.startsWith("/") || /^[A-Za-z]:/u.test(cleaned)) throw new Error(`Refusing absolute zip entry ${name}.`);
  const target = normalize(join(destination, cleaned));
  const inside = relative(destination, target);
  if (inside.startsWith("..") || isAbsolute(inside) || inside.split(sep).includes(".."))
    throw new Error(`Refusing zip entry ${name}, which points outside the destination.`);
  return target;
}

/** Extracts a zip archive with streaming inflate, keeping executable bits and refusing entries that escape. */
export async function extractZip(archive: string, destination: string): Promise<number> {
  const handle = await open(archive, "r");
  try {
    const { size } = await handle.stat();
    const tailLength = Math.min(size, 22 + MAX_COMMENT);
    const tailOffset = size - tailLength;
    const tail = await readAt(handle, tailOffset, tailLength);
    const end = findEndOfCentralDirectory(tail);
    const entries = parseCentralDirectory(await readAt(handle, end.offset, end.size), end.count);
    let written = 0;
    for (const entry of entries) {
      const target = safeEntryPath(destination, entry.name);
      const type = entry.mode === undefined ? undefined : entry.mode & S_IFMT;
      if (entry.name.endsWith("/") || type === S_IFDIR) {
        await mkdir(target, { recursive: true });
        continue;
      }
      await mkdir(dirname(target), { recursive: true });
      const header = await readAt(handle, entry.localHeaderOffset, 30);
      if (header.length < 30 || header.readUInt32LE(0) !== LOCAL_FILE_HEADER)
        throw new Error(`The zip entry ${entry.name} is damaged.`);
      const dataOffset = entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
      if (type === S_IFLNK) {
        const link = (await readAt(handle, dataOffset, entry.compressedSize)).toString("utf8");
        safeEntryPath(destination, join(dirname(entry.name), link));
        await symlink(link, target);
        continue;
      }
      if (entry.method !== 0 && entry.method !== 8)
        throw new Error(`The zip entry ${entry.name} uses compression method ${entry.method}, which is not supported.`);
      const output = createWriteStream(target);
      if (entry.compressedSize === 0) {
        await new Promise<void>((resolve, reject) =>
          output.end((error?: Error | null) => (error ? reject(error) : resolve())),
        );
      } else {
        const source = handle.createReadStream({
          start: dataOffset,
          end: dataOffset + entry.compressedSize - 1,
          autoClose: false,
        });
        if (entry.method === 8) await pipeline(source, createInflateRaw(), output);
        else await pipeline(source, output);
      }
      if (entry.mode !== undefined && (entry.mode & 0o111) !== 0) await chmod(target, entry.mode & 0o777);
      written += 1;
    }
    return written;
  } finally {
    await handle.close();
  }
}

async function readAt(handle: FileHandle, offset: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, offset + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}
