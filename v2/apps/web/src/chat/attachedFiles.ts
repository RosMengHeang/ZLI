/** Heads the list of files picked from disk. Agents read them from there, so the bytes never upload. */
const HEADING = "Attached files:";
const ITEM = /^- (?:`([^`\n]+)`|(.+))$/u;

/** The message with the picked files listed after it, one path per line. */
export function withAttachedFiles(paths: readonly string[], message: string): string {
  if (paths.length === 0) return message;
  const list = paths.map((path) => (path.includes("`") ? `- ${path}` : `- \`${path}\``)).join("\n");
  return message ? `${message}\n\n${HEADING}\n${list}` : `${HEADING}\n${list}`;
}

/** Undoes `withAttachedFiles`, so a sent message can show its files apart from what the person typed. */
export function splitAttachedFiles(text: string): { text: string; paths: string[] } {
  const marker = `\n\n${HEADING}\n`;
  const at = text.lastIndexOf(marker);
  const [body, list] =
    at !== -1
      ? [text.slice(0, at), text.slice(at + marker.length)]
      : text.startsWith(`${HEADING}\n`)
        ? ["", text.slice(HEADING.length + 1)]
        : [text, undefined];
  if (list === undefined) return { text, paths: [] };
  const paths: string[] = [];
  for (const line of list.replace(/\n+$/u, "").split("\n")) {
    const match = ITEM.exec(line);
    const path = match?.[1] ?? match?.[2];
    if (!path) return { text, paths: [] };
    paths.push(path);
  }
  return { text: body, paths };
}

/** The last part of a Windows or POSIX path. */
export function fileName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/u, "");
  return trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1) || trimmed;
}

/** The folder the file sits in, by name only. */
export function parentName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/u, "");
  const split = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return split > 0 ? fileName(trimmed.slice(0, split)) : "";
}

/** The lowercased extension without its dot; empty for names like `Makefile` or `.env`. */
export function fileExtension(path: string): string {
  const name = fileName(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export type FileKind = "pdf" | "doc" | "sheet" | "slides" | "archive" | "code" | "media" | "other";

const KINDS: Record<Exclude<FileKind, "other">, readonly string[]> = {
  pdf: ["pdf"],
  doc: ["doc", "docx", "odt", "rtf", "pages", "txt", "md", "markdown", "log"],
  sheet: ["xls", "xlsx", "xlsm", "csv", "tsv", "ods", "numbers"],
  slides: ["ppt", "pptx", "odp", "key"],
  archive: ["zip", "tar", "gz", "tgz", "bz2", "xz", "rar", "7z"],
  code: [
    "ts",
    "tsx",
    "js",
    "jsx",
    "mjs",
    "cjs",
    "json",
    "py",
    "rb",
    "go",
    "rs",
    "java",
    "kt",
    "swift",
    "c",
    "h",
    "cc",
    "cpp",
    "hpp",
    "cs",
    "php",
    "sh",
    "ps1",
    "sql",
    "html",
    "css",
    "scss",
    "yaml",
    "yml",
    "toml",
    "xml",
  ],
  media: [
    "png",
    "jpg",
    "jpeg",
    "gif",
    "webp",
    "svg",
    "bmp",
    "tif",
    "tiff",
    "heic",
    "ico",
    "mp4",
    "mov",
    "webm",
    "mp3",
    "wav",
  ],
};

export function fileKind(path: string): FileKind {
  const extension = fileExtension(path);
  for (const [kind, extensions] of Object.entries(KINDS)) {
    if (extensions.includes(extension)) return kind as FileKind;
  }
  return "other";
}
