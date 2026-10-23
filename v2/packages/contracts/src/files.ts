import { z } from "zod";

import { WorktreeId } from "./ids.js";

/** Worktree-relative path with forward slashes, for example `src/app.ts`. */
export const WorktreeFilePath = z
  .string()
  .min(1)
  .max(4_000)
  .refine(
    (value) =>
      !value.includes("\0") &&
      !value.includes("\\") &&
      !value.startsWith("/") &&
      !/^[A-Za-z]:/u.test(value) &&
      value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    "Path must be relative to the worktree and use forward slashes.",
  );
export type WorktreeFilePath = z.infer<typeof WorktreeFilePath>;

/** Text files larger than this are listed but not opened in the editor. */
export const MAX_EDITABLE_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_LISTED_FILES = 50_000;
/** Images and PDFs up to this size can be previewed. */
export const MAX_PREVIEW_FILE_BYTES = 10 * 1024 * 1024;

/** File types the Files panel previews from their bytes, by lowercase extension. */
export const PREVIEW_MIME_TYPES = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
  pdf: "application/pdf",
} as const;
export const PreviewMimeType = z.enum([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/x-icon",
  "image/svg+xml",
  "application/pdf",
]);
export type PreviewMimeType = z.infer<typeof PreviewMimeType>;

/** The preview type for a path, or undefined when ZLI does not preview that kind of file. */
export function previewMimeType(path: string): PreviewMimeType | undefined {
  const dot = path.lastIndexOf(".");
  if (dot < 0 || dot < path.lastIndexOf("/")) return undefined;
  const extension = path.slice(dot + 1).toLowerCase();
  return Object.hasOwn(PREVIEW_MIME_TYPES, extension)
    ? PREVIEW_MIME_TYPES[extension as keyof typeof PREVIEW_MIME_TYPES]
    : undefined;
}
export const MAX_SEARCH_RESULTS = 2_000;

/** Handled directly by the runtime server; none of these reach the event log. */
export const FileCommand = z.discriminatedUnion("type", [
  z.object({ type: z.literal("files.list"), worktreeId: WorktreeId }),
  z.object({ type: z.literal("files.read"), worktreeId: WorktreeId, path: WorktreeFilePath }),
  /** The bytes of an image or PDF, for previews. */
  z.object({ type: z.literal("files.readData"), worktreeId: WorktreeId, path: WorktreeFilePath }),
  /** The file's uncommitted changes against HEAD, as a unified diff. */
  z.object({ type: z.literal("files.diff"), worktreeId: WorktreeId, path: WorktreeFilePath }),
  z.object({
    type: z.literal("files.write"),
    worktreeId: WorktreeId,
    path: WorktreeFilePath,
    content: z.string().max(MAX_EDITABLE_FILE_BYTES * 2),
    /** Version from the last read; a different version on disk means someone else changed the file. */
    expectedVersion: z.string().min(1).max(128),
    /** Restores a UTF-8 byte order mark the read stripped. */
    bom: z.boolean().optional(),
    /** Writes even when the file changed on disk since `expectedVersion`. */
    overwrite: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("files.search"),
    worktreeId: WorktreeId,
    query: z.string().min(1).max(1_000),
    caseSensitive: z.boolean().optional(),
    regex: z.boolean().optional(),
    maxResults: z.number().int().positive().max(MAX_SEARCH_RESULTS).optional(),
  }),
]);
export type FileCommand = z.infer<typeof FileCommand>;
export const FILE_COMMAND_TYPES = [
  "files.list",
  "files.read",
  "files.readData",
  "files.diff",
  "files.write",
  "files.search",
] as const;

/** Uncommitted state from `git status`; absent for unchanged files. */
export const FileChangeStatus = z.enum(["modified", "added", "deleted", "renamed", "untracked", "conflicted"]);
export type FileChangeStatus = z.infer<typeof FileChangeStatus>;

export const FileListEntry = z.object({
  path: z.string(),
  size: z.number().int().nonnegative().optional(),
  status: FileChangeStatus.optional(),
  /** Lines added and removed against HEAD. Absent for untracked and binary files. */
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
});
export type FileListEntry = z.infer<typeof FileListEntry>;

/** Tracked files plus untracked files Git does not ignore, sorted by path. */
export const FileListResult = z.object({
  files: z.array(FileListEntry),
  truncated: z.boolean(),
});
export type FileListResult = z.infer<typeof FileListResult>;

export const FileReadResult = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
  /** sha256 of the bytes on disk; send it back as `expectedVersion` when saving. */
  version: z.string(),
  /** Present only for UTF-8 text files up to MAX_EDITABLE_FILE_BYTES. */
  content: z.string().optional(),
  binary: z.boolean(),
  tooLarge: z.boolean(),
  bom: z.boolean(),
  lineEnding: z.enum(["lf", "crlf"]),
});
export type FileReadResult = z.infer<typeof FileReadResult>;

export const FileDataResult = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
  version: z.string(),
  mimeType: PreviewMimeType,
  dataBase64: z.string(),
});
export type FileDataResult = z.infer<typeof FileDataResult>;

export const MAX_FILE_DIFF_CHARS = 200_000;

export const FileDiffResult = z.object({
  path: z.string(),
  binary: z.boolean(),
  /** Empty when the file has no uncommitted changes. New files show every line as added. */
  patch: z.string().max(MAX_FILE_DIFF_CHARS),
  truncated: z.boolean(),
});
export type FileDiffResult = z.infer<typeof FileDiffResult>;

export const FileWriteResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("saved"), path: z.string(), version: z.string(), size: z.number().int().nonnegative() }),
  /** The file changed on disk since it was read; nothing was written. */
  z.object({ status: z.literal("conflict"), path: z.string(), version: z.string() }),
]);
export type FileWriteResult = z.infer<typeof FileWriteResult>;

export const FileSearchMatch = z.object({
  path: z.string(),
  line: z.number().int().positive(),
  column: z.number().int().positive(),
  /** The matching line, trimmed to a readable length. */
  preview: z.string(),
});
export type FileSearchMatch = z.infer<typeof FileSearchMatch>;

export const FileSearchResult = z.object({
  matches: z.array(FileSearchMatch),
  truncated: z.boolean(),
});
export type FileSearchResult = z.infer<typeof FileSearchResult>;
