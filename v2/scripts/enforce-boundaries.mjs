import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const IMPORT_PATTERN =
  /(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "coverage") continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(absolutePath)));
    else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(absolutePath);
  }

  return files;
}

function importedSpecifiers(source) {
  return [...source.matchAll(IMPORT_PATTERN)].map((match) => match[1] ?? match[2]);
}

async function workspacePackages(v2Root) {
  const packageRoots = [path.join(v2Root, "apps"), path.join(v2Root, "packages")];
  const packages = new Map();

  for (const packageRoot of packageRoots) {
    let entries = [];
    try {
      entries = await readdir(packageRoot, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const root = path.join(packageRoot, entry.name);
      try {
        const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
        if (typeof manifest.name === "string") packages.set(manifest.name, { root, manifest });
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }

  return packages;
}

function owningPackage(file, packages) {
  return [...packages.values()].find(({ root }) => {
    const relative = path.relative(root, file);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  });
}

function violation(file, specifier, rule) {
  return { file, specifier, rule };
}

export async function findBoundaryViolations(v2Root) {
  const resolvedRoot = path.resolve(v2Root);
  const packages = await workspacePackages(resolvedRoot);
  const files = await walk(resolvedRoot);
  const violations = [];

  for (const file of files.sort()) {
    const source = await readFile(file, "utf8");
    const owner = owningPackage(file, packages);
    const isWeb = file.startsWith(`${path.join(resolvedRoot, "apps", "web")}${path.sep}`);

    for (const specifier of importedSpecifiers(source)) {
      if (specifier.startsWith(".")) {
        const target = path.resolve(path.dirname(file), specifier);
        const legacySrc = path.resolve(resolvedRoot, "..", "src");
        const legacyTauri = path.resolve(resolvedRoot, "..", "src-tauri");
        if (
          target === legacySrc ||
          target.startsWith(`${legacySrc}${path.sep}`) ||
          target === legacyTauri ||
          target.startsWith(`${legacyTauri}${path.sep}`)
        ) {
          violations.push(violation(file, specifier, "no-legacy-imports"));
        }
      }

      if (isWeb && specifier === "electron") violations.push(violation(file, specifier, "web-no-electron"));
      if (isWeb && specifier.startsWith("node:")) violations.push(violation(file, specifier, "web-no-node"));

      if (specifier.startsWith("@zli-v2/") && packages.has(specifier) && owner) {
        const declared = {
          ...owner.manifest.dependencies,
          ...owner.manifest.devDependencies,
          ...owner.manifest.peerDependencies,
        };
        if (!(specifier in declared)) {
          violations.push(violation(file, specifier, "declared-workspace-dependency"));
        }
      }
    }
  }

  return violations;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const v2Root = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
  const violations = await findBoundaryViolations(v2Root);
  if (violations.length > 0) {
    for (const item of violations)
      console.error(`${item.rule}: ${path.relative(v2Root, item.file)} imports ${item.specifier}`);
    process.exitCode = 1;
  }
}
