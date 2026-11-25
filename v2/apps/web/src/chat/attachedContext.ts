/**
 * What the message box adds after the person's words: "#" blocks (a diff, another chat, a pull request)
 * and the file mentions and skill requests from picked chips. Each goes out inside a
 * `<zli-context kind="…" label="…">` section, so the agent reads it as attached, and the chat can show it
 * as a tag under the message instead of as part of what the person typed.
 */

const OPEN = /^<zli-context kind="([a-zA-Z]+)"(?: label="([^"\n]*)")?>$/u;
const CLOSE = "</zli-context>";

/** The section the picked files and skills go in. */
export const MENTIONS_KIND = "mentions";

export type AttachedContext = {
  kind: string;
  label: string;
  /** Everything between the markers, exactly as it was sent. */
  content: string;
};

export type SplitContext = {
  /** What the person typed, without the attached sections. */
  body: string;
  /** The "#" blocks, in order. */
  attachments: AttachedContext[];
  /** Files mentioned by picked chips. */
  files: string[];
  /** Skills asked for by picked chips or a typed `$name`. */
  skills: string[];
};

/** One attached section. The label is for the chat's tag; quotes and line breaks cannot go in it. */
export function attachedSection(kind: string, label: string, content: string): string {
  const clean = label
    .replace(/[\r\n]+/gu, " ")
    .replaceAll('"', "'")
    .trim();
  return `<zli-context kind="${kind}"${clean ? ` label="${clean}"` : ""}>\n${content.trim()}\n${CLOSE}`;
}

const lineOf = (line: string) => line.replace(/\r$/u, "");

/** Sections from `start` to the end of the text, or undefined when anything else is in between. */
function sectionsFrom(lines: readonly string[], start: number): AttachedContext[] | undefined {
  const sections: AttachedContext[] = [];
  let at = start;
  while (at < lines.length) {
    const open = OPEN.exec(lineOf(lines[at] ?? ""));
    if (!open) return undefined;
    // A chat's transcript can quote messages that had sections of their own, so they nest.
    let depth = 1;
    let end = at + 1;
    for (; end < lines.length; end += 1) {
      const line = lineOf(lines[end] ?? "");
      if (OPEN.test(line)) depth += 1;
      else if (line === CLOSE) depth -= 1;
      if (depth === 0) break;
    }
    if (depth !== 0) return undefined;
    sections.push({ kind: open[1] ?? "", label: open[2] ?? "", content: lines.slice(at + 1, end).join("\n") });
    at = end + 1;
    if (at < lines.length && lineOf(lines[at] ?? "") !== "") return undefined;
    while (at < lines.length && lineOf(lines[at] ?? "").trim() === "") at += 1;
  }
  return sections;
}

const FILE_TOKEN = /@"([^"\n]+)"|@(\S+)/gu;
const SKILL_SENTENCE = /Use the (\S+) skill\./gu;
const SKILL_TOKEN = /(?:^|\s)\$([a-zA-Z][a-zA-Z0-9:_-]*)/gu;

/**
 * Splits a sent message into what the person typed and the sections the message box added at its end.
 * A message with no sections, or one whose end only looks like them, comes back whole as the body.
 */
export function splitAttachedContext(text: string): SplitContext {
  const whole: SplitContext = { body: text, attachments: [], files: [], skills: [] };
  if (!text.includes(CLOSE)) return whole;
  const lines = text.split("\n");
  for (let start = 0; start < lines.length; start += 1) {
    if (start > 0 && lineOf(lines[start - 1] ?? "").trim() !== "") continue;
    if (!OPEN.test(lineOf(lines[start] ?? ""))) continue;
    const sections = sectionsFrom(lines, start);
    if (!sections) continue;
    const files: string[] = [];
    const skills: string[] = [];
    const attachments: AttachedContext[] = [];
    for (const section of sections) {
      if (section.kind !== MENTIONS_KIND) {
        attachments.push(section);
        continue;
      }
      for (const match of section.content.matchAll(FILE_TOKEN)) {
        const path = match[1] ?? match[2];
        if (path && !files.includes(path)) files.push(path);
      }
      for (const match of [...section.content.matchAll(SKILL_SENTENCE), ...section.content.matchAll(SKILL_TOKEN)]) {
        const name = match[1];
        if (name && !skills.includes(name)) skills.push(name);
      }
    }
    return { body: lines.slice(0, start).join("\n").trimEnd(), attachments, files, skills };
  }
  return whole;
}

/** The block's text without the heading line it opens with, for showing under its tag. */
export function attachedText(section: AttachedContext): string {
  return section.content.replace(/^### Context: [^\n]*\n+/u, "");
}
