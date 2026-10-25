import { createHash, randomBytes } from "node:crypto";
import type { Dirent } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import { SKILL_FILE, skillNameProblem } from "@zli-v2/contracts";

import { type ParsedSkillMarkdown, parseSkillMarkdown } from "./skillMarkdown.js";

export const MAX_SKILL_FILES = 500;
export const MAX_SKILL_BYTES = 10 * 1024 * 1024;
export const MAX_SKILL_FILE_BYTES = 1024 * 1024;
/** Folders listed per skills directory, so a huge folder cannot stall Settings. */
const MAX_LISTED = 500;
const MAX_DEPTH = 16;

export type SkillFolder = {
  /** The folder name. */
  name: string;
  description: string;
  path: string;
  problem?: string;
  parsed: ParsedSkillMarkdown;
};

export class SkillError extends Error {}

/** Why a SKILL.md cannot be used as written, or undefined. */
export function skillProblem(folderName: string, parsed: ParsedSkillMarkdown): string | undefined {
  if (!parsed.hasFrontmatter) return "SKILL.md has no frontmatter with a name and description.";
  const nameProblem = skillNameProblem(folderName);
  if (nameProblem) return `The folder name ${folderName} does not fit the skill naming rule. ${nameProblem}`;
  if (!parsed.name) return "SKILL.md has no name.";
  if (parsed.name !== folderName) return `SKILL.md names it ${parsed.name}, which differs from the folder name.`;
  if (!parsed.description) return "SKILL.md has no description, so agents cannot tell when to use it.";
  return undefined;
}

/** The skill in `path`, or undefined when the folder has no readable SKILL.md. */
export async function readSkillFolder(path: string, name: string): Promise<SkillFolder | undefined> {
  const file = join(path, SKILL_FILE);
  let text: string;
  try {
    const info = await stat(file);
    if (!info.isFile()) return undefined;
    if (info.size > MAX_SKILL_FILE_BYTES) {
      return { name, description: "", path, problem: "SKILL.md is too large to read.", parsed: emptyParse() };
    }
    text = await readFile(file, "utf8");
  } catch {
    return undefined;
  }
  const parsed = parseSkillMarkdown(text);
  const problem = skillProblem(name, parsed);
  return { name, description: parsed.description ?? "", path, ...(problem ? { problem } : {}), parsed };
}

/** Every skill folder directly inside `root`. Linked folders are followed, since tools often link skills in. */
export async function listSkillFolders(root: string): Promise<SkillFolder[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const names = entries
    .filter((entry) => !entry.name.startsWith(".") && (entry.isDirectory() || entry.isSymbolicLink()))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right))
    .slice(0, MAX_LISTED);
  const folders = await Promise.all(names.map((name) => readSkillFolder(join(root, name), name)));
  return folders.filter((folder): folder is SkillFolder => folder !== undefined);
}

/** Regular files under `dir`, relative and with forward slashes. Links are skipped, never followed. */
export async function skillFileList(dir: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || files.length >= MAX_SKILL_FILES) return;
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path, depth + 1);
      else if (entry.isFile() && files.length < MAX_SKILL_FILES) files.push(relative(dir, path).split(sep).join("/"));
    }
  };
  await walk(dir, 0);
  return files;
}

/** A digest of the folder's files, used to tell whether a copy is current. */
export async function hashSkillFolder(dir: string): Promise<string> {
  const hash = createHash("sha256");
  for (const file of await skillFileList(dir)) {
    hash.update(file);
    hash.update("\0");
    hash.update(await readFile(join(dir, ...file.split("/"))));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function pathKind(path: string): Promise<"missing" | "directory" | "link" | "other"> {
  try {
    const info = await lstat(path);
    return info.isSymbolicLink() ? "link" : info.isDirectory() ? "directory" : "other";
  } catch (error) {
    if (isNotFound(error)) return "missing";
    throw error;
  }
}

/**
 * Fills a temporary folder beside `target`, then swaps it in, so agents never read a half-written skill.
 * An existing folder or link at `target` is replaced.
 */
export async function replaceFolder(target: string, fill: (temp: string) => Promise<void>): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const temp = join(dirname(target), `.zli-${randomBytes(6).toString("hex")}.tmp`);
  try {
    await mkdir(temp);
    await fill(temp);
    await rm(target, { recursive: true, force: true });
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/** Copies the regular files of a skill folder. Links are left out so a copy never points outside it. */
export async function copySkillFolder(from: string, to: string): Promise<void> {
  for (const file of await skillFileList(from)) {
    const destination = join(to, ...file.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(from, ...file.split("/")), destination);
  }
}

export async function writeSkillFiles(to: string, files: ReadonlyArray<{ path: string; data: Uint8Array }>) {
  for (const file of files) {
    const destination = join(to, ...file.path.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, file.data);
  }
}

export function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function emptyParse(): ParsedSkillMarkdown {
  return { hasFrontmatter: false, name: undefined, description: undefined, body: "", blocks: [] };
}
