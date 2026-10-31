/** Which half of a file's uncommitted diff: HEAD against the index, or the index against the working tree. */
export type DiffPart = "staged" | "unstaged";

/**
 * Arguments for one half of a file's diff. The prefixes are fixed so `git apply` reads the patch the same way
 * whatever diff.noprefix or diff.mnemonicPrefix say, and literal pathspecs keep `*` or `:(...)` in a name literal.
 */
export function partDiffArgs(part: DiffPart, path: string): string[] {
  return [
    "--literal-pathspecs",
    "diff",
    "--no-ext-diff",
    "--no-color",
    "--unified=3",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    ...(part === "staged" ? ["--cached"] : []),
    "--",
    path,
  ];
}

export type PatchHunks = { header: string[]; hunks: string[][] };

/**
 * Splits a one-file `git diff` into its header (`diff --git`, mode, `---`, `+++` lines) and its hunks, each from
 * its `@@` line to the line before the next one. Returns undefined for patches Git cannot apply a hunk of,
 * such as combined diffs of a conflict or binary changes.
 */
export function splitPatch(patch: string): PatchHunks | undefined {
  const lines = patch.split("\n");
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  if (!lines[0]?.startsWith("diff --git ")) return undefined;
  const first = lines.findIndex((line) => line.startsWith("@@ "));
  if (first < 0) return undefined;
  const header = lines.slice(0, first);
  if (header.slice(1).some((line) => line.startsWith("diff --git ") || line.startsWith("Binary files "))) {
    return undefined;
  }
  const hunks: string[][] = [];
  for (const line of lines.slice(first)) {
    if (line.startsWith("@@ ")) hunks.push([line]);
    else hunks.at(-1)?.push(line);
  }
  return { header, hunks };
}

/** A patch holding only the `index`th hunk, or undefined when the hunk is not the one the person saw. */
export function hunkPatch(patch: string, index: number, expected: string): string | undefined {
  const split = splitPatch(patch);
  const hunk = split?.hunks[index];
  if (!split || !hunk || hunk.join("\n") !== trimEnd(expected)) return undefined;
  return `${[...split.header, ...hunk].join("\n")}\n`;
}

function trimEnd(value: string): string {
  return value.replace(/\n+$/u, "");
}
