import { baseName } from "./filePaths.js";

export type FuzzyMatch = { path: string; score: number; indices: number[] };

/**
 * Subsequence match over the path, preferring hits in the file name, at segment starts, and in
 * runs. Returns undefined when the query characters do not all appear in order.
 */
export function fuzzyMatch(query: string, path: string): FuzzyMatch | undefined {
  const needle = query.replaceAll("\\", "/").replace(/\s+/gu, "").toLowerCase();
  if (!needle) return { path, score: 0, indices: [] };
  const haystack = path.toLowerCase();
  const nameStart = path.length - baseName(path).length;
  const indices: number[] = [];
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const character of needle) {
    // Prefer the next occurrence that starts a segment or continues a run; fall back to the first.
    let chosen = -1;
    for (let index = haystack.indexOf(character, from); index !== -1; index = haystack.indexOf(character, index + 1)) {
      if (index === previous + 1 || isSegmentStart(path, index)) {
        chosen = index;
        break;
      }
      if (chosen === -1) chosen = index;
      if (index - from > 40) break;
    }
    if (chosen === -1) return undefined;
    score += 1;
    if (chosen === previous + 1) score += 4;
    if (isSegmentStart(path, chosen)) score += 3;
    if (chosen >= nameStart) score += 2;
    indices.push(chosen);
    previous = chosen;
    from = chosen + 1;
  }
  const name = baseName(path).toLowerCase();
  if (name === needle) score += 40;
  else if (name.startsWith(needle)) score += 20;
  else if (name.includes(needle)) score += 10;
  score -= path.length / 100;
  return { path, score, indices };
}

function isSegmentStart(path: string, index: number): boolean {
  if (index === 0) return true;
  const before = path[index - 1] ?? "";
  const current = path[index] ?? "";
  return (
    before === "/" ||
    before === "." ||
    before === "-" ||
    before === "_" ||
    (before.toLowerCase() === before && current.toUpperCase() === current && current.toLowerCase() !== current)
  );
}

export function rankFiles(query: string, paths: readonly string[], limit = 50): FuzzyMatch[] {
  const matches: FuzzyMatch[] = [];
  for (const path of paths) {
    const match = fuzzyMatch(query, path);
    if (match) matches.push(match);
  }
  matches.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
  return matches.slice(0, limit);
}
