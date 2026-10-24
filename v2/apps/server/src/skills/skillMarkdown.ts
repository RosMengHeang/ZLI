/** One top-level frontmatter key with the exact lines it spans, so a rewrite keeps keys ZLI does not edit. */
type FrontmatterBlock = { key: string | undefined; lines: string[] };

export type ParsedSkillMarkdown = {
  /** False when the file has no `---` frontmatter at the top. */
  hasFrontmatter: boolean;
  name: string | undefined;
  description: string | undefined;
  body: string;
  blocks: FrontmatterBlock[];
};

const KEY_LINE = /^([A-Za-z0-9_.-]+)[ \t]*:(.*)$/u;
const FENCE = /^---[ \t]*$/u;
const END_FENCE = /^(?:---|\.\.\.)[ \t]*$/u;

/**
 * Reads the name and description from SKILL.md frontmatter. Covers the YAML that skills use in practice:
 * plain, quoted, and block (`|`, `>`) scalars on top-level keys. Anything else is kept as raw lines.
 */
export function parseSkillMarkdown(text: string): ParsedSkillMarkdown {
  const lines = text.replace(/^\uFEFF/u, "").split(/\r?\n/u);
  if (!FENCE.test(lines[0] ?? "")) {
    return { hasFrontmatter: false, name: undefined, description: undefined, body: lines.join("\n"), blocks: [] };
  }
  const end = lines.findIndex((line, index) => index > 0 && END_FENCE.test(line));
  if (end < 0) {
    return { hasFrontmatter: false, name: undefined, description: undefined, body: lines.join("\n"), blocks: [] };
  }
  const blocks: FrontmatterBlock[] = [];
  for (const line of lines.slice(1, end)) {
    const key = KEY_LINE.exec(line)?.[1];
    const last = blocks.at(-1);
    if (key !== undefined || !last) blocks.push({ key, lines: [line] });
    else last.lines.push(line);
  }
  const value = (key: string): string | undefined => {
    const block = blocks.find((entry) => entry.key === key);
    return block ? scalarValue(block.lines) : undefined;
  };
  const rest = lines.slice(end + 1);
  if (rest[0]?.trim() === "") rest.shift();
  return {
    hasFrontmatter: true,
    name: value("name"),
    description: value("description"),
    body: rest.join("\n"),
    blocks,
  };
}

function scalarValue(lines: string[]): string | undefined {
  const [first = "", ...more] = lines;
  const raw = (KEY_LINE.exec(first)?.[2] ?? "").trim();
  const continuation = more.filter((line) => !/^\s*#/u.test(line));
  if (/^[|>][+-]?\d?$/u.test(raw)) {
    const indents = continuation.filter((line) => line.trim()).map((line) => /^\s*/u.exec(line)?.[0].length ?? 0);
    const indent = indents.length > 0 ? Math.min(...indents) : 0;
    const body = continuation.map((line) => line.slice(indent));
    const joined = raw.startsWith("|")
      ? body.join("\n")
      : body
          .join("\n")
          .split(/\n[ \t]*\n/u)
          .map((paragraph) => paragraph.split("\n").join(" "))
          .join("\n");
    return joined.trim();
  }
  const whole = [raw, ...continuation.map((line) => line.trim())].join(" ").trim();
  if (whole.startsWith('"')) {
    const closing = whole.lastIndexOf('"');
    try {
      return JSON.parse(whole.slice(0, closing + 1)) as string;
    } catch {
      return whole.slice(1, closing > 0 ? closing : undefined);
    }
  }
  if (whole.startsWith("'")) {
    const closing = whole.lastIndexOf("'");
    return whole.slice(1, closing > 0 ? closing : undefined).replaceAll("''", "'");
  }
  return whole.replace(/\s+#.*$/u, "").trim() || undefined;
}

/** A YAML scalar for one line: plain when that reads back the same, otherwise double-quoted. */
export function yamlScalar(value: string): string {
  const plain =
    value.length > 0 &&
    value.trim() === value &&
    !/[\n\r\t]/u.test(value) &&
    !/^[-?:,[\]{}#&*!|>'"%@`]/u.test(value) &&
    !/: |:$| #/u.test(value) &&
    !/^(?:true|false|yes|no|on|off|null|~|[-+]?\d[\d._]*(?:e[-+]?\d+)?)$/iu.test(value);
  // JSON strings are valid YAML double-quoted scalars.
  return plain ? value : JSON.stringify(value);
}

/**
 * SKILL.md with the given name, description, and instructions. Other frontmatter keys from `previous`,
 * such as license or allowed-tools, stay as they were written.
 */
export function formatSkillMarkdown(
  skill: { name: string; description: string; instructions: string },
  previous?: ParsedSkillMarkdown,
): string {
  const nameLine = `name: ${yamlScalar(skill.name)}`;
  const descriptionLine = `description: ${yamlScalar(skill.description)}`;
  const kept = previous?.blocks ?? [];
  const front: string[] = [];
  let wroteName = false;
  let wroteDescription = false;
  for (const block of kept) {
    if (block.key === "name") {
      if (!wroteName) front.push(nameLine);
      wroteName = true;
    } else if (block.key === "description") {
      if (!wroteName) front.push(nameLine);
      wroteName = true;
      front.push(descriptionLine);
      wroteDescription = true;
    } else {
      front.push(...block.lines);
    }
  }
  const head = [...(wroteName ? [] : [nameLine]), ...(wroteDescription ? [] : [descriptionLine])];
  const instructions = skill.instructions.replace(/\r\n/gu, "\n").replace(/\s+$/u, "");
  return `---\n${[...head, ...front].join("\n")}\n---\n${instructions ? `\n${instructions}\n` : ""}`;
}
