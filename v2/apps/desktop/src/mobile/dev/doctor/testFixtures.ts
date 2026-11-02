import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** A fixture project's files keyed by where createTestDevHost should see them, under root. */
export function fixtureFiles(name: string, root = "/repo/app"): Record<string, string> {
  const dir = fileURLToPath(new URL(`./fixtures/${name}/`, import.meta.url));
  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files[`${root}/${relative(dir, path).split(sep).join("/")}`] = readFileSync(path, "utf8");
  }
  return files;
}
