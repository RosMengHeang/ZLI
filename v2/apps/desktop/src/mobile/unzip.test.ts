import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { extractZip, safeEntryPath } from "./unzip.js";

type Entry = { name: string; data?: string; mode?: number; store?: boolean };

/** A minimal zip writer for tests: no CRCs, which the extractor does not check. */
function buildZip(entries: Entry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const raw = Buffer.from(entry.data ?? "");
    const data = entry.store || raw.length === 0 ? raw : deflateRawSync(raw);
    const method = entry.store || raw.length === 0 ? 0 : 8;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zli-unzip-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("zip extraction", () => {
  it("extracts stored and deflated files and keeps executable bits", async () => {
    const archive = join(root, "tools.zip");
    await writeFile(
      archive,
      buildZip([
        { name: "cmdline-tools/", mode: 0o040755 },
        { name: "cmdline-tools/bin/sdkmanager", data: "#!/bin/sh\necho sdk\n".repeat(50), mode: 0o100755 },
        { name: "cmdline-tools/NOTICE.txt", data: "notice", store: true },
        { name: "cmdline-tools/empty", data: "" },
      ]),
    );
    const out = join(root, "out");
    expect(await extractZip(archive, out)).toBe(3);
    expect(await readFile(join(out, "cmdline-tools", "bin", "sdkmanager"), "utf8")).toBe(
      "#!/bin/sh\necho sdk\n".repeat(50),
    );
    expect(await readFile(join(out, "cmdline-tools", "NOTICE.txt"), "utf8")).toBe("notice");
    expect(await readFile(join(out, "cmdline-tools", "empty"), "utf8")).toBe("");
    if (process.platform !== "win32")
      expect((await stat(join(out, "cmdline-tools", "bin", "sdkmanager"))).mode & 0o111).not.toBe(0);
  });

  it("refuses entries that would land outside the destination", async () => {
    const archive = join(root, "evil.zip");
    await writeFile(archive, buildZip([{ name: "../escape.txt", data: "x" }]));
    await expect(extractZip(archive, join(root, "out"))).rejects.toThrow(/outside the destination/u);
    expect(() => safeEntryPath(root, "/etc/passwd")).toThrow(/absolute/u);
    expect(() => safeEntryPath(root, "C:\\Windows\\x")).toThrow(/absolute/u);
    expect(safeEntryPath(root, "a/b.txt")).toBe(join(root, "a", "b.txt"));
  });

  it("rejects files that are not zip archives", async () => {
    const archive = join(root, "plain.zip");
    await writeFile(archive, "not a zip at all");
    await expect(extractZip(archive, join(root, "out"))).rejects.toThrow(/not a zip archive/u);
  });
});
