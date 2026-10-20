import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AttachmentError, MAX_ATTACHMENT_BYTES, matchesMimeType, storeThreadAttachments } from "./attachments.js";

const threadId = "00000000-0000-4000-8000-000000000701";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "zli-attachments-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("storeThreadAttachments", () => {
  it("writes uploaded bytes under the thread directory and returns path-only attachments", async () => {
    const root = await tempRoot();
    const [stored] = await storeThreadAttachments(root, threadId, [
      { name: "shot.png", mimeType: "image/png", dataBase64: PNG.toString("base64") },
    ]);

    expect(stored).toMatchObject({ name: "shot.png", mimeType: "image/png" });
    expect(stored).not.toHaveProperty("dataBase64");
    expect(stored?.path.startsWith(join(root, threadId))).toBe(true);
    expect(stored?.path.endsWith(".png")).toBe(true);
    expect(await readFile(stored?.path ?? "")).toEqual(PNG);
  });

  it("stores the same bytes at the same path so retried commands stay identical", async () => {
    const root = await tempRoot();
    const upload = { name: "shot.png", mimeType: "image/png" as const, dataBase64: PNG.toString("base64") };
    const [first] = await storeThreadAttachments(root, threadId, [upload]);
    const [second] = await storeThreadAttachments(root, threadId, [upload]);
    expect(second?.path).toBe(first?.path);
  });

  it("rejects bytes that do not match the declared image type", async () => {
    const root = await tempRoot();
    await expect(
      storeThreadAttachments(root, threadId, [
        { name: "fake.jpg", mimeType: "image/jpeg", dataBase64: PNG.toString("base64") },
      ]),
    ).rejects.toThrow("Attachment fake.jpg is not a image/jpeg image.");
    await expect(
      storeThreadAttachments(root, threadId, [
        { name: "script.png", mimeType: "image/png", dataBase64: Buffer.from("#!/bin/sh\n").toString("base64") },
      ]),
    ).rejects.toBeInstanceOf(AttachmentError);
  });

  it("rejects images larger than 10 MiB and malformed base64", async () => {
    const root = await tempRoot();
    const large = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1);
    PNG.copy(large);
    await expect(
      storeThreadAttachments(root, threadId, [
        { name: "large.png", mimeType: "image/png", dataBase64: large.toString("base64") },
      ]),
    ).rejects.toThrow("larger than 10 MiB");
    await expect(
      storeThreadAttachments(root, threadId, [{ name: "bad.png", mimeType: "image/png", dataBase64: "iVBO R w==" }]),
    ).rejects.toThrow("not valid base64");
  });

  it("accepts a client path only when it points at an image already stored for the thread", async () => {
    const root = await tempRoot();
    const [stored] = await storeThreadAttachments(root, threadId, [
      { name: "shot.png", mimeType: "image/png", dataBase64: PNG.toString("base64") },
    ]);
    await expect(
      storeThreadAttachments(root, threadId, [{ name: "again.png", mimeType: "image/png", path: stored?.path ?? "" }]),
    ).resolves.toMatchObject([{ name: "again.png", path: stored?.path }]);

    const outside = join(root, "outside.png");
    await writeFile(outside, PNG);
    await expect(
      storeThreadAttachments(root, threadId, [{ name: "outside.png", mimeType: "image/png", path: outside }]),
    ).rejects.toThrow("must be an image stored for this thread");
    await expect(
      storeThreadAttachments(root, threadId, [
        { name: "escape.png", mimeType: "image/png", path: join(root, threadId, "..", "outside.png") },
      ]),
    ).rejects.toThrow("must be an image stored for this thread");

    const otherThread = join(root, "00000000-0000-4000-8000-000000000702");
    await mkdir(otherThread, { recursive: true });
    await writeFile(join(otherThread, "other.png"), PNG);
    await expect(
      storeThreadAttachments(root, threadId, [
        { name: "other.png", mimeType: "image/png", path: join(otherThread, "other.png") },
      ]),
    ).rejects.toThrow("must be an image stored for this thread");
  });

  it("rejects uploads when the runtime has no attachment directory", async () => {
    await expect(
      storeThreadAttachments(undefined, threadId, [
        { name: "shot.png", mimeType: "image/png", dataBase64: PNG.toString("base64") },
      ]),
    ).rejects.toThrow("unavailable");
  });
});

describe("matchesMimeType", () => {
  it("recognizes each supported signature", () => {
    expect(matchesMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg")).toBe(true);
    expect(matchesMimeType(Buffer.from("GIF89a"), "image/gif")).toBe(true);
    expect(matchesMimeType(Buffer.from("RIFF\x10\x00\x00\x00WEBPVP8 "), "image/webp")).toBe(true);
    expect(matchesMimeType(Buffer.from("RIFF\x10\x00\x00\x00WAVEfmt "), "image/webp")).toBe(false);
    expect(matchesMimeType(Buffer.from([0x89, 0x50]), "image/png")).toBe(false);
  });
});
