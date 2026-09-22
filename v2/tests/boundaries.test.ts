import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

import { findBoundaryViolations } from "../scripts/enforce-boundaries.mjs";

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "zli-v2-boundaries-"));

  await Promise.all(
    Object.entries(files).map(async ([relativePath, contents]) => {
      const absolutePath = path.join(root, relativePath);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, contents, "utf8");
    }),
  );

  return root;
}

test("rejects imports from the legacy application", async () => {
  const root = await fixture({
    "v2/apps/server/src/main.ts": 'import legacy from "../../../../src/App";\n',
  });

  const violations = await findBoundaryViolations(path.join(root, "v2"));

  expect(violations.map(({ rule }) => rule)).toEqual(["no-legacy-imports"]);
});

test("rejects Electron and Node imports in the web renderer", async () => {
  const root = await fixture({
    "v2/apps/web/src/main.tsx": ['import { ipcRenderer } from "electron";', 'import fs from "node:fs";'].join("\n"),
  });

  const violations = await findBoundaryViolations(path.join(root, "v2"));

  expect(violations.map(({ rule }) => rule)).toEqual(["web-no-electron", "web-no-node"]);
});

test("accepts imports through declared workspace dependencies", async () => {
  const root = await fixture({
    "v2/apps/web/package.json": JSON.stringify({
      name: "@zli-v2/web",
      dependencies: { "@zli-v2/contracts": "workspace:*" },
    }),
    "v2/apps/web/src/main.tsx": 'import { RpcRequest } from "@zli-v2/contracts";\n',
    "v2/packages/contracts/package.json": JSON.stringify({
      name: "@zli-v2/contracts",
    }),
  });

  expect(await findBoundaryViolations(path.join(root, "v2"))).toEqual([]);
});

test("rejects undeclared workspace package imports", async () => {
  const root = await fixture({
    "v2/apps/web/package.json": JSON.stringify({ name: "@zli-v2/web" }),
    "v2/apps/web/src/main.tsx": 'import { RpcRequest } from "@zli-v2/contracts";\n',
    "v2/packages/contracts/package.json": JSON.stringify({
      name: "@zli-v2/contracts",
    }),
  });

  const violations = await findBoundaryViolations(path.join(root, "v2"));

  expect(violations.map(({ rule }) => rule)).toEqual(["declared-workspace-dependency"]);
});
