import { gzipSync } from "node:zlib";

/** Builds GitHub-shaped tarballs for tests. */
export function tarHeader(path: string, size: number, type = "0", linkName = ""): Buffer {
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, "utf8");
  header.write("0000644\0", 100, "latin1");
  header.write("0000000\0", 108, "latin1");
  header.write("0000000\0", 116, "latin1");
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "latin1");
  header.write("00000000000\0", 136, "latin1");
  header.write("        ", 148, "latin1");
  header.write(type, 156, "latin1");
  header.write(linkName, 157, "latin1");
  header.write("ustar\0", 257, "latin1");
  header.write("00", 263, "latin1");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
  return header;
}

function block(data: Buffer): Buffer {
  return Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

export type TarInput = { path: string; text?: string; type?: string; linkName?: string; pax?: boolean };

/** A gzipped tarball shaped like GitHub's: a global pax header, then everything under one top folder. */
export function githubTarball(entries: readonly TarInput[]): Buffer {
  const parts: Buffer[] = [];
  const comment = Buffer.from("52 comment=0123456789abcdef0123456789abcdef01234567\n");
  parts.push(tarHeader("pax_global_header", comment.length, "g"), block(comment));
  for (const entry of entries) {
    const data = Buffer.from(entry.text ?? "");
    const path = `owner-repo-0123456/${entry.path}`;
    if (entry.pax) {
      const record = ` path=${path}\n`;
      let length = record.length + 2;
      while (`${length}${record}`.length !== length) length += 1;
      const pax = Buffer.from(`${length}${record}`);
      parts.push(tarHeader("PaxHeader", pax.length, "x"), block(pax));
      parts.push(tarHeader("short-name", data.length, entry.type ?? "0", entry.linkName));
    } else {
      parts.push(tarHeader(path, data.length, entry.type ?? "0", entry.linkName));
    }
    if (data.length > 0) parts.push(block(data));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

export function fakeFetch(body: Buffer, seen: string[] = [], status = 200): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push(`${String(input)} ${JSON.stringify(init?.headers ?? {})}`);
    return new Response(status === 200 ? new Uint8Array(body) : "nope", { status });
  }) as typeof fetch;
}
