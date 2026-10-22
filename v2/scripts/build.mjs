import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const desktopDist = resolve(root, "apps/desktop/dist");

await rm(desktopDist, { recursive: true, force: true });
await mkdir(desktopDist, { recursive: true });

const shared = {
  bundle: true,
  sourcemap: true,
  platform: "node",
  target: "node24",
  logLevel: "info",
};

await build({
  ...shared,
  entryPoints: [resolve(root, "apps/desktop/src/main.ts")],
  outfile: resolve(desktopDist, "main.js"),
  format: "esm",
  external: ["electron", "ws"],
});

await build({
  ...shared,
  entryPoints: [resolve(root, "apps/desktop/src/preload.ts")],
  outfile: resolve(desktopDist, "preload.js"),
  format: "cjs",
  external: ["electron"],
});

// Agents run this under ELECTRON_RUN_AS_NODE, so it must not import electron.
await build({
  ...shared,
  entryPoints: [resolve(root, "apps/desktop/src/browser-tool/zli-browser.ts")],
  outfile: resolve(desktopDist, "zli-browser.js"),
  format: "esm",
});

await build({
  ...shared,
  entryPoints: [resolve(root, "apps/desktop/src/agent-tool/zli.ts")],
  outfile: resolve(desktopDist, "zli.js"),
  format: "esm",
});

await build({
  ...shared,
  entryPoints: [resolve(root, "apps/server/src/main.ts")],
  outfile: resolve(desktopDist, "server-entry.js"),
  format: "esm",
  external: ["node-pty", "ws"],
});

await build({
  ...shared,
  entryPoints: [resolve(root, "apps/server/src/daemon-entry.ts")],
  outfile: resolve(desktopDist, "daemon-entry.js"),
  format: "esm",
  external: ["node-pty"],
});
