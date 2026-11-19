import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const roots = ["../../../../packages/ui/src", ".."].map((dir) => fileURLToPath(new URL(dir, import.meta.url)));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sources(path);
    return /\.(css|ts|tsx)$/u.test(name) ? [path] : [];
  });
}

const text = roots
  .flatMap(sources)
  .map((file) => readFileSync(file, "utf8"))
  .join("\n");

describe("theme tokens", () => {
  it("only uses tokens that something defines", () => {
    const defined = new Set([...text.matchAll(/["']?(--zli-[\w-]+)["']?\s*[:,]/gu)].map((match) => match[1]));
    // A var() with no fallback and an unknown name paints nothing, and no theme can change it.
    const missing = [...text.matchAll(/var\((--zli-[\w-]+)\s*\)/gu)]
      .map((match) => match[1])
      .filter((name) => !defined.has(name));
    expect([...new Set(missing)]).toEqual([]);
  });

  it("paints menus and popups from the theme, not a fixed dark color", () => {
    expect(text).not.toMatch(/var\(--zli-popup/u);
  });
});
