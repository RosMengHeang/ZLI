import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function blockBody(css, openingPattern) {
  const opening = openingPattern.exec(css);
  assert.ok(opening, `Missing CSS block matching ${openingPattern}`);

  const bodyStart = opening.index + opening[0].length;
  let depth = 1;
  for (let index = bodyStart; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    if (css[index] === "}") depth -= 1;
    if (depth === 0) return css.slice(bodyStart, index);
  }

  throw new Error(`Unclosed CSS block matching ${openingPattern}`);
}

function declarationsFrom(body, target) {
  for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    target.set(match[1], match[2].trim());
  }
}

function defaultDarkTokenGraph(css) {
  const declarations = new Map();
  declarationsFrom(blockBody(css, /@theme\s*\{/g), declarations);
  declarationsFrom(
    blockBody(css, /:root\s*,\s*\[data-theme=["']dark["']\]\s*\{/g),
    declarations,
  );
  return declarations;
}

function resolveToken(name, declarations, trail = []) {
  if (trail.includes(name)) {
    throw new Error(`Circular custom property dependency: ${[...trail, name].join(" -> ")}`);
  }

  const value = declarations.get(name);
  assert.ok(value, `Missing custom property ${name}`);
  return value.replace(/var\(\s*(--[\w-]+)\s*\)/g, (_, dependency) =>
    resolveToken(dependency, declarations, [...trail, name]),
  );
}

test("default and dark semantic colors resolve without custom-property cycles", async () => {
  const css = await readFile(new URL("../src/index.css", import.meta.url), "utf8");
  const tokens = defaultDarkTokenGraph(css);

  assert.doesNotThrow(() => resolveToken("--accent", tokens));
  assert.doesNotThrow(() => resolveToken("--danger", tokens));
});
