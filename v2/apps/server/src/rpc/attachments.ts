import { createHash } from "node:crypto";
import { mkdir, open, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

import type { AttachmentMimeType, ThreadAttachment, ThreadAttachmentUpload } from "@zli-v2/contracts";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const EXTENSIONS: Record<AttachmentMimeType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "text/plain": "txt",
};

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u;
const THREAD_DIRECTORY = /^[A-Za-z0-9-]+$/u;

export class AttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentError";
  }
}

/**
 * Writes uploaded file bytes under `<root>/<threadId>/` and returns path-only attachments, so the
 * durable event log never holds image data. Files are named by content hash, which keeps a retried
 * command (same commandId, same bytes) identical to the original and therefore idempotent.
 */
export async function storeThreadAttachments(
  root: string | undefined,
  threadId: string,
  uploads: readonly ThreadAttachmentUpload[],
): Promise<ThreadAttachment[]> {
  if (uploads.length === 0) return [];
  if (!root) throw new AttachmentError("Attachments are unavailable in this runtime.");
  if (!THREAD_DIRECTORY.test(threadId)) throw new AttachmentError("Attachment thread id is invalid.");
  const directory = join(root, threadId);
  const stored: ThreadAttachment[] = [];
  for (const upload of uploads) {
    if (upload.dataBase64 !== undefined) {
      stored.push(await storeUpload(directory, upload.name, upload.mimeType, upload.dataBase64));
    } else if (upload.path !== undefined) {
      stored.push(await adoptStoredFile(directory, upload.name, upload.mimeType, upload.path));
    } else {
      throw new AttachmentError(`Attachment ${upload.name} has no data.`);
    }
  }
  return stored;
}

async function storeUpload(
  directory: string,
  name: string,
  mimeType: AttachmentMimeType,
  dataBase64: string,
): Promise<ThreadAttachment> {
  if (dataBase64.length % 4 !== 0 || !BASE64.test(dataBase64)) {
    throw new AttachmentError(`Attachment ${name} is not valid base64.`);
  }
  if ((dataBase64.length / 4) * 3 - padding(dataBase64) > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentError(`Attachment ${name} is larger than 10 MiB.`);
  }
  const bytes = Buffer.from(dataBase64, "base64");
  if (bytes.length === 0) throw new AttachmentError(`Attachment ${name} is empty.`);
  if (!matchesMimeType(bytes, mimeType)) {
    throw new AttachmentError(mismatch(name, mimeType));
  }
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${createHash("sha256").update(bytes).digest("hex")}.${EXTENSIONS[mimeType]}`);
  try {
    await writeFile(path, bytes, { flag: "wx" });
  } catch (error) {
    if (!isErrorCode(error, "EEXIST")) throw error;
  }
  return { name, mimeType, path };
}

/** A client may resend a file this runtime already stored for the same thread, but nothing else on disk. */
async function adoptStoredFile(
  directory: string,
  name: string,
  mimeType: AttachmentMimeType,
  candidate: string,
): Promise<ThreadAttachment> {
  const rejected = new AttachmentError(`Attachment ${name} must be a file stored for this thread.`);
  if (!isAbsolute(candidate)) throw rejected;
  let resolvedDirectory: string;
  let resolvedPath: string;
  try {
    resolvedDirectory = await realpath(directory);
    resolvedPath = await realpath(candidate);
  } catch {
    throw rejected;
  }
  const inside = relative(resolvedDirectory, resolvedPath);
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) throw rejected;
  const info = await stat(resolvedPath);
  if (!info.isFile() || info.size === 0 || info.size > MAX_ATTACHMENT_BYTES) throw rejected;
  const bytes = mimeType === "text/plain" ? await readFile(resolvedPath) : await readHead(resolvedPath);
  if (!matchesMimeType(bytes, mimeType)) throw new AttachmentError(mismatch(name, mimeType));
  return { name, mimeType, path: resolvedPath };
}

function mismatch(name: string, mimeType: AttachmentMimeType): string {
  return mimeType === "text/plain"
    ? `Attachment ${name} is not plain UTF-8 text.`
    : `Attachment ${name} is not a ${mimeType} image.`;
}

export function matchesMimeType(bytes: Uint8Array, mimeType: AttachmentMimeType): boolean {
  const startsWith = (signature: readonly number[], offset = 0) =>
    bytes.length >= offset + signature.length && signature.every((byte, index) => bytes[offset + index] === byte);
  switch (mimeType) {
    case "image/png":
      return startsWith([0x89, 0x50, 0x4e, 0x47]);
    case "image/jpeg":
      return startsWith([0xff, 0xd8, 0xff]);
    case "image/gif":
      return startsWith([0x47, 0x49, 0x46, 0x38]);
    case "image/webp":
      return startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8);
    case "text/plain":
      return isPlainText(bytes);
  }
}

function isPlainText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

async function readHead(path: string): Promise<Uint8Array> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(12);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function padding(value: string): number {
  if (value.endsWith("==")) return 2;
  return value.endsWith("=") ? 1 : 0;
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
