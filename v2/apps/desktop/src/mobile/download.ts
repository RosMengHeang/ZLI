import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  body: ReadableStream<Uint8Array> | null;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export class ChecksumMismatchError extends Error {
  constructor(
    readonly url: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `The download from ${url} is damaged or was tampered with: its checksum is ${actual}, expected ${expected}. Nothing from it was installed.`,
    );
    this.name = "ChecksumMismatchError";
  }
}

export type VerifiedDownload = {
  readonly url: string;
  readonly destination: string;
  readonly algorithm: "sha1" | "sha256";
  readonly checksum: string;
  readonly fetch: FetchLike;
  readonly signal?: AbortSignal;
  readonly onProgress?: (received: number, total: number | undefined) => void;
};

/**
 * Streams a download to disk while hashing it, and moves it into place only when the checksum matches.
 * A mismatched or interrupted file is deleted so it can never be extracted by mistake.
 */
export async function downloadVerified(options: VerifiedDownload): Promise<string> {
  if (!options.url.startsWith("https://")) throw new Error(`Refusing to download over plain HTTP: ${options.url}`);
  await mkdir(dirname(options.destination), { recursive: true });
  const partial = `${options.destination}.partial`;
  await rm(partial, { force: true });
  const response = await options.fetch(options.url, options.signal ? { signal: options.signal } : {});
  if (!response.ok || !response.body) throw new Error(`Download failed with HTTP ${response.status}: ${options.url}`);
  const lengthHeader = Number(response.headers.get("content-length"));
  const total = Number.isFinite(lengthHeader) && lengthHeader > 0 ? lengthHeader : undefined;
  const hash = createHash(options.algorithm);
  const file = createWriteStream(partial, { mode: 0o644 });
  let received = 0;
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      received += value.length;
      if (!file.write(value)) await new Promise<void>((resolve) => file.once("drain", resolve));
      options.onProgress?.(received, total);
    }
    await new Promise<void>((resolve, reject) =>
      file.end((error?: Error | null) => (error ? reject(error) : resolve())),
    );
  } catch (cause) {
    file.destroy();
    await rm(partial, { force: true });
    throw cause;
  }
  const actual = hash.digest("hex");
  if (actual !== options.checksum.toLowerCase()) {
    await rm(partial, { force: true });
    throw new ChecksumMismatchError(options.url, options.checksum.toLowerCase(), actual);
  }
  await rename(partial, options.destination);
  return options.destination;
}
