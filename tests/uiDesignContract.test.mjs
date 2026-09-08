import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the Taxzy UI keeps an intentional workspace visual contract", async () => {
  const css = await readFile(new URL("../src/index.css", import.meta.url), "utf8");
  const design = await readFile(new URL("../DESIGN.md", import.meta.url), "utf8");

  assert.match(design, /ENERGY 2 \/\s*RHYTHM 2 \/\s*MOTION 1/);
  assert.match(design, /Bricolage Grotesque/);
  assert.match(css, /--font-brand: "Bricolage Grotesque"/);
  assert.match(css, /\.app-shell\s*\{/);
  assert.doesNotMatch(css, /radial-gradient\(/);
  assert.doesNotMatch(css, /text-transform:\s*uppercase/);
});
