import { agentNameKey, type FileListEntry, type SkillListResult } from "@zli-v2/contracts";

import { rankFiles } from "../files/fuzzy.js";
import type { Buddy } from "../teammates/buddies.js";
import { attachedSection, MENTIONS_KIND } from "./attachedContext.js";
import type { ContextChoice } from "./contextSources.js";

/**
 * Someone the person can call with @Name: a member of the chat, an agent in another chat of the project, or a
 * buddy who gets the message as a job. The "@" list in the message box (ComposerMenu) shows them above the
 * worktree's files.
 */
export type MentionOption = {
  name: string;
  buddy: Buddy;
  provider: string;
  /** Says who it is and whether it is in the chat yet, such as "Codex · in this chat". */
  detail: string;
  /** A member of the chat, an agent in another chat, or a buddy who gets the message as a job. Members when left out. */
  kind?: "member" | "peer" | "buddy";
};

/**
 * What the word at the caret asks for: "@" a file or teammate, "#" something ZLI knows about (a chat, a
 * pull request, the diff), "$" a skill, "/" at the start of the message a command. Where the word starts
 * and ends, so a pick can replace it.
 */
export type ComposerTrigger = {
  kind: "file" | "context" | "skill" | "command";
  query: string;
  start: number;
  end: number;
};

const MAX_QUERY = 200;

/** The trigger the caret sits in, or undefined when the word there is plain text. */
export function detectTrigger(text: string, caret: number): ComposerTrigger | undefined {
  const end = Math.max(0, Math.min(text.length, caret));
  let start = end;
  while (start > 0 && !/\s/u.test(text.charAt(start - 1))) start -= 1;
  const token = text.slice(start, end);
  if (token.length < 1 || token.length > MAX_QUERY + 1) return undefined;
  const query = token.slice(1);
  switch (token.charAt(0)) {
    case "@":
      return query.includes("@") ? undefined : { kind: "file", query, start, end };
    case "#":
      // "##" is a heading, and "#a#b" is not a word anyone picks from a list.
      return query.includes("#") ? undefined : { kind: "context", query, start, end };
    case "$":
      // "$5" and "$10k" are money. Skill names are letters, digits, and hyphens.
      if (/^[0-9]/u.test(query) || !/^[a-zA-Z0-9:_-]*$/u.test(query)) return undefined;
      return { kind: "skill", query, start, end };
    case "/":
      // Commands open only at the very start; "/usr/bin" or a second slash is a path.
      if (start !== 0 || query.includes("/")) return undefined;
      return { kind: "command", query, start, end };
    default:
      return undefined;
  }
}

/**
 * Puts `replacement` where the trigger word was, plus the rest of that word if the caret sat inside it,
 * and leaves one space after it. Returns the new text and where the caret goes.
 */
export function replaceTrigger(
  text: string,
  trigger: Pick<ComposerTrigger, "start" | "end">,
  replacement: string,
): { text: string; caret: number } {
  const rest = text.slice(trigger.end).replace(/^\S*/u, "");
  const inserted = replacement.length > 0 ? `${replacement} ` : "";
  const after = inserted ? rest.replace(/^ /u, "") : rest;
  return { text: text.slice(0, trigger.start) + inserted + after, caret: trigger.start + inserted.length };
}

/** `@path`, quoted when the path has a space, so the agent reads it as one file. */
export function fileMention(path: string): string {
  return /\s/u.test(path) ? `@"${path}"` : `@${path}`;
}

const FILE_LIMIT = 30;

/** Files for an "@" query: fuzzy on the path; with no query, files with uncommitted changes first. */
export function matchFiles(query: string, entries: readonly FileListEntry[], limit = FILE_LIMIT): string[] {
  const present = entries.filter((entry) => entry.status !== "deleted");
  if (!query.trim()) {
    const changed = present.filter((entry) => entry.status);
    const rest = present.filter((entry) => !entry.status);
    return [...changed, ...rest].slice(0, limit).map((entry) => entry.path);
  }
  return rankFiles(
    query,
    present.map((entry) => entry.path),
    limit,
  ).map((match) => match.path);
}

export type SkillChoice = { name: string; description: string; scope: "user" | "project" };

/**
 * Skills the chat's agent can load: ZLI's own (enabled ones, and project ones, which are always on) and
 * skills already in the agent's folders. One entry per name; ZLI's copy wins.
 */
export function skillChoices(result: SkillListResult | undefined, provider: string | undefined): SkillChoice[] {
  if (!result) return [];
  const byName = new Map<string, SkillChoice>();
  for (const skill of result.skills) {
    if (!skill.enabled || skill.problem || byName.has(skill.name)) continue;
    byName.set(skill.name, { name: skill.name, description: skill.description, scope: skill.scope });
  }
  for (const skill of result.found) {
    if (skill.problem || byName.has(skill.name)) continue;
    if (provider && !(skill.agents as readonly string[]).includes(provider)) continue;
    byName.set(skill.name, { name: skill.name, description: skill.description, scope: skill.scope });
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/** Name starts first, then name contains, then description contains. */
function rankByName<T>(items: readonly T[], query: string, name: (item: T) => string, text: (item: T) => string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...items];
  const rank = (item: T) => {
    const key = name(item).toLowerCase();
    if (key.startsWith(needle)) return 0;
    if (key.includes(needle)) return 1;
    if (text(item).toLowerCase().includes(needle)) return 2;
    return -1;
  };
  return items
    .map((item, index) => ({ item, index, rank: rank(item) }))
    .filter((entry) => entry.rank >= 0)
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((entry) => entry.item);
}

export function matchSkills(query: string, skills: readonly SkillChoice[]): SkillChoice[] {
  return rankByName(
    skills,
    query,
    (skill) => skill.name,
    (skill) => skill.description,
  );
}

/**
 * A "/" command. `run` does it in ZLI and clears the "/" text; `insert` puts text in the box for the
 * person to finish and send, for commands the agent itself understands.
 */
export type ComposerCommand = {
  name: string;
  description: string;
  run?: () => void;
  insert?: string;
  /** Who handles it, shown as the group: ZLI, or the agent's CLI. */
  source?: "zli" | "agent";
};

export function matchCommands(query: string, commands: readonly ComposerCommand[]): ComposerCommand[] {
  return rankByName(
    commands,
    query,
    (command) => command.name,
    (command) => command.description,
  );
}

const SKILL_TOKEN = /(^|\s)\$([a-zA-Z][a-zA-Z0-9:_-]*)(?=\s|$|[.,;:!?)])/gu;

/** Skill names the text mentions as `$name`, in order, once each, keeping only known skills. */
export function mentionedSkills(text: string, known: ReadonlySet<string>): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(SKILL_TOKEN)) {
    const name = match[2] ?? "";
    if (known.has(name) && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * Codex reads `$name` as a skill on its own. Other agents see only text, so the message gets a plain line
 * asking for each skill by name; that is what makes them load it.
 */
export function withSkillRequests(text: string, skills: readonly string[], provider: string | undefined): string {
  if (skills.length === 0 || provider === "codex") return text;
  const line = skills.map((name) => `Use the ${name} skill.`).join(" ");
  return text ? `${text}\n\n${line}` : line;
}

/** Something picked from the menu, shown as a chip above the text until the message goes. */
export type ComposerChip =
  | { kind: "person"; key: string; label: string; option: MentionOption }
  | { kind: "file"; key: string; label: string; path: string }
  | { kind: "skill"; key: string; label: string; name: string }
  | { kind: "context"; key: string; label: string; choice: ContextChoice };

/** The chip for someone called with @Name. */
export function personChip(option: MentionOption): ComposerChip {
  return { kind: "person", key: `person:${agentNameKey(option.name)}`, label: option.name, option };
}

/** Adds a chip unless the same one is already there. */
export function addChip(chips: readonly ComposerChip[], chip: ComposerChip): ComposerChip[] {
  return chips.some((existing) => existing.key === chip.key) ? [...chips] : [...chips, chip];
}

/**
 * `@Name` for each person chip, at the very start, where the chat looks for who a message is for: a member
 * of the chat, or a buddy who gets it as a job.
 */
export function withPersonChips(chips: readonly ComposerChip[], message: string): string {
  const names = chips.flatMap((chip) => (chip.kind === "person" ? [`@${chip.option.name}`] : []));
  if (names.length === 0) return message;
  return message ? `${names.join(" ")} ${message}` : names.join(" ");
}

/**
 * The message with what the other chips stand for: a section after the text with the file mentions and
 * then the skill requests, then the "#" blocks. `blocks` are the loaded "#" chips, in order.
 */
export function withChips(
  text: string,
  chips: readonly ComposerChip[],
  options: { knownSkills: ReadonlySet<string>; provider: string | undefined; blocks: readonly string[] },
): string {
  const files = chips.flatMap((chip) => (chip.kind === "file" ? [fileMention(chip.path)] : []));
  let added = files.join(" ");
  const typed = mentionedSkills(text, options.knownSkills);
  const picked = chips.flatMap((chip) => (chip.kind === "skill" && !typed.includes(chip.name) ? [chip.name] : []));
  // Codex loads a skill from `$name` in the text, so a picked one goes in that way.
  if (options.provider === "codex" && picked.length > 0) {
    const tokens = picked.map((name) => `$${name}`).join(" ");
    added = added ? `${added}\n\n${tokens}` : tokens;
  }
  added = withSkillRequests(added, [...typed, ...picked], options.provider);
  // In a marked section, so the chat shows these as tags instead of as typed words.
  const section = added ? attachedSection(MENTIONS_KIND, "", added) : "";
  const message = section ? (text ? `${text}\n\n${section}` : section) : text;
  const blocks = options.blocks.filter((block) => block.trim());
  if (blocks.length === 0) return message;
  return message ? `${message}\n\n${blocks.join("\n\n")}` : blocks.join("\n\n");
}
