import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const desktopDist = resolve(root, "apps/desktop/dist");

const shared = {
  bundle: true,
  sourcemap: true,
  platform: "node",
  target: "node24",
  logLevel: "info",
};

/** The esbuild bundles for the desktop app, shared by build.mjs and dev-hot.mjs. */
export const bundles = [
  {
    ...shared,
    entryPoints: [resolve(root, "apps/desktop/src/main.ts")],
    outfile: resolve(desktopDist, "main.js"),
    format: "esm",
    // electron-updater stays a package in node_modules: it is CommonJS that requires its own files lazily.
    external: ["electron", "electron-updater", "ws"],
    // Squirrel.Mac only installs updates into a signed app, so release builds say whether theirs is.
    define: { __ZLI_MAC_SIGNED__: JSON.stringify(process.env.ZLI_MAC_SIGNED === "1") },
  },

  {
    ...shared,
    entryPoints: [resolve(root, "apps/desktop/src/preload.ts")],
    outfile: resolve(desktopDist, "preload.js"),
    format: "cjs",
    external: ["electron"],
  },

  // Agents run this under ELECTRON_RUN_AS_NODE, so it must not import electron.
  {
    ...shared,
    entryPoints: [resolve(root, "apps/desktop/src/browser-tool/zli-browser.ts")],
    outfile: resolve(desktopDist, "zli-browser.js"),
    format: "esm",
  },

  {
    ...shared,
    entryPoints: [resolve(root, "apps/desktop/src/agent-tool/zli.ts")],
    outfile: resolve(desktopDist, "zli.js"),
    format: "esm",
  },

  {
    ...shared,
    entryPoints: [resolve(root, "apps/desktop/src/mobile-tool/zli-mobile.ts")],
    outfile: resolve(desktopDist, "zli-mobile.js"),
    format: "esm",
  },

  // The MCP sign-in bridge agents launch; also run under ELECTRON_RUN_AS_NODE.
  {
    ...shared,
    entryPoints: [resolve(root, "apps/server/src/connect-entry.ts")],
    outfile: resolve(desktopDist, "zli-connect.js"),
    format: "esm",
  },

  {
    ...shared,
    entryPoints: [resolve(root, "apps/server/src/main.ts")],
    outfile: resolve(desktopDist, "server-entry.js"),
    format: "esm",
    external: ["node-pty", "ws"],
  },

  {
    ...shared,
    entryPoints: [resolve(root, "apps/server/src/daemon-entry.ts")],
    outfile: resolve(desktopDist, "daemon-entry.js"),
    format: "esm",
    external: ["node-pty"],
  },
];
