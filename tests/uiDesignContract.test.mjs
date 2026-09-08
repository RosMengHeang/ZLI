import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readConfigFile, sys } from "typescript";
import { build } from "vite";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const primitiveNames = [
  "button",
  "input",
  "badge",
  "separator",
  "tooltip",
  "dialog",
  "tabs",
  "scroll-area",
  "collapsible",
  "dropdown-menu",
  "resizable",
];

test("the Taxzy shadcn foundation matches the approved design contract", async () => {
  const [componentsSource, viteSource, css, design] = await Promise.all([
      readFile(path.join(projectRoot, "components.json"), "utf8"),
      readFile(path.join(projectRoot, "vite.config.ts"), "utf8"),
      readFile(path.join(projectRoot, "src/index.css"), "utf8"),
      readFile(
        path.join(
          projectRoot,
          "docs/superpowers/specs/2026-09-09-macos-shadcn-workspace-design.md",
        ),
        "utf8",
      ),
    ]);

  const components = JSON.parse(componentsSource);
  const tsconfigPath = path.join(projectRoot, "tsconfig.json");
  const parsedTsconfig = readConfigFile(tsconfigPath, sys.readFile);
  assert.equal(parsedTsconfig.error, undefined);
  const tsconfig = parsedTsconfig.config;

  assert.equal(components.style, "new-york");
  assert.equal(components.rsc, false);
  assert.equal(components.tsx, true);
  assert.equal(components.tailwind.config, "");
  assert.equal(components.tailwind.css, "src/index.css");
  assert.equal(components.tailwind.cssVariables, true);
  assert.equal(components.aliases.components, "@/components");
  assert.equal(components.aliases.ui, "@/components/ui");
  assert.equal(components.aliases.utils, "@/lib/utils");

  assert.deepEqual(tsconfig.compilerOptions.paths["@/*"], ["./src/*"]);
  assert.match(viteSource, /alias:\s*\{[\s\S]*["']?@["']?\s*:/);

  const primitiveSources = await Promise.all(
    primitiveNames.map((name) =>
      readFile(
        path.join(projectRoot, `src/components/ui/${name}.tsx`),
        "utf8",
      ),
    ),
  );
  await readFile(path.join(projectRoot, "src/lib/utils.ts"), "utf8");

  const primitiveSource = primitiveSources.join("\n");
  assert.doesNotMatch(
    primitiveSource,
    /(?:linear|radial|conic)-gradient\(|\bgradient-[^\s"']+/,
  );
  assert.doesNotMatch(primitiveSource, /\bglow\b|\bdrop-shadow(?:-|\b)/);
  assert.doesNotMatch(primitiveSource, /\buppercase\b/);
  assert.doesNotMatch(
    primitiveSource,
    /\banimate-(?!none\b)[^\s"']+|\btransition-all\b/,
  );
  assert.doesNotMatch(primitiveSource, /\brounded-full\b/);

  assert.match(design, /ENERGY 1 \/ RHYTHM 2 \/ MOTION 1/);
  assert.match(
    css,
    /--font-sans:\s*"Inter Variable", Inter, "Segoe UI Variable Text", "Segoe UI Variable", "Segoe UI", sans-serif;/,
  );
  assert.match(css, /--font-mono:\s*"JetBrains Mono", "SFMono-Regular", Consolas, monospace/);

  const exactTokens = [
    "--app-canvas: #181818",
    "--sidebar: #202020",
    "--surface: #212121",
    "--surface-raised: #262626",
    "--surface-hover: #2a2a2a",
    "--surface-selected: #303030",
    "--separator: #333333",
    "--border-subtle: #2b2b2b",
    "--text-primary: #ececec",
    "--text-secondary: #a1a1aa",
    "--text-tertiary: #737373",
    "--accent: #ffffff",
    "--app-canvas: #fafaf9",
    "--sidebar: #f5f5f4",
    "--surface: #ffffff",
    "--surface-hover: #f5f5f4",
    "--surface-selected: #ececea",
    "--separator: #e7e7e5",
    "--border-subtle: #efefec",
    "--text-primary: #171717",
    "--text-secondary: #737373",
    "--text-tertiary: #a3a3a3",
    "--accent: #111111",
  ];

  for (const token of exactTokens) {
    assert.match(css, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  assert.doesNotMatch(css, /(?:linear|radial|conic)-gradient\(/);
  assert.doesNotMatch(css, /text-shadow|filter:\s*drop-shadow/);
  assert.doesNotMatch(css, /text-transform:\s*uppercase/);
});

test("all local UI primitives bundle through the public @ alias boundary", async () => {
  const contractDirectory = await mkdtemp(
    path.join(tmpdir(), "taxzy-ui-contract-"),
  );
  const entryPath = path.join(contractDirectory, "ui-contract.tsx");
  const imports = primitiveNames
    .map(
      (name, index) =>
        `import * as primitive${index} from "@/components/ui/${name}";`,
    )
    .join("\n");

  try {
    await writeFile(
      entryPath,
      `${imports}\nexport const localUiBoundary = [${primitiveNames
        .map((_, index) => `primitive${index}`)
        .join(", ")}];\n`,
      "utf8",
    );

    const result = await build({
      configFile: path.join(projectRoot, "vite.config.ts"),
      logLevel: "silent",
      build: {
        write: false,
        lib: {
          entry: entryPath,
          formats: ["es"],
          fileName: "ui-contract",
        },
      },
    });

    const outputs = Array.isArray(result) ? result : [result];
    assert.ok(
      outputs.some((output) =>
        output.output.some(
          (item) => item.type === "chunk" && item.fileName === "ui-contract.js",
        ),
      ),
    );
  } finally {
    await rm(contractDirectory, { recursive: true, force: true });
  }
});
