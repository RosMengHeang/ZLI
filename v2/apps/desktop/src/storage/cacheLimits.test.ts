import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CODE_CACHE_LIMIT_BYTES, trimCodeCaches } from "./cacheLimits.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function profile(): string {
  const root = mkdtempSync(join(tmpdir(), "zli-cache-"));
  roots.push(root);
  mkdirSync(join(root, "Code Cache", "js"), { recursive: true });
  writeFileSync(join(root, "Code Cache", "js", "entry"), "x");
  mkdirSync(join(root, "Partitions", "tab-1", "Code Cache", "js"), { recursive: true });
  writeFileSync(join(root, "Partitions", "tab-1", "Code Cache", "js", "entry"), "x");
  mkdirSync(join(root, "Cache"), { recursive: true });
  return root;
}

describe("trimCodeCaches", () => {
  it("leaves the caches on the first launch and records the build", () => {
    const root = profile();
    expect(trimCodeCaches(root, "1.0.0:1").reason).toBe("none");
    expect(existsSync(join(root, "Code Cache"))).toBe(true);
    expect(readFileSync(join(root, "zli-code-cache-build.txt"), "utf8")).toBe("1.0.0:1");
  });

  it("clears every code cache once the build changes, and nothing else", () => {
    const root = profile();
    trimCodeCaches(root, "1.0.0:1");
    const result = trimCodeCaches(root, "1.0.1:2");
    expect(result.reason).toBe("build");
    expect(result.cleared).toHaveLength(2);
    expect(existsSync(join(root, "Code Cache"))).toBe(false);
    expect(existsSync(join(root, "Partitions", "tab-1", "Code Cache"))).toBe(false);
    expect(existsSync(join(root, "Partitions", "tab-1"))).toBe(true);
    expect(existsSync(join(root, "Cache"))).toBe(true);
  });

  it("clears a code cache past the size limit on the same build", () => {
    const root = profile();
    trimCodeCaches(root, "1.0.0:1");
    writeFileSync(join(root, "Code Cache", "js", "big"), Buffer.alloc(CODE_CACHE_LIMIT_BYTES + 1));
    const result = trimCodeCaches(root, "1.0.0:1");
    expect(result).toEqual({ reason: "size", cleared: [join(root, "Code Cache")] });
    expect(existsSync(join(root, "Partitions", "tab-1", "Code Cache"))).toBe(true);
  });
});
