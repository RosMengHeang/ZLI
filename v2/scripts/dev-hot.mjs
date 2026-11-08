import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import electronPath from "electron";
import { context } from "esbuild";
import { bundles, desktopDist } from "./bundles.mjs";

// UI changes hot reload through the Vite dev server. Everything else Electron runs (main, preload,
// server, providers) cannot be swapped in place, so a rebuild of those restarts Electron instead.

const RENDERER_URL = "http://localhost:5173";
const main = resolve(desktopDist, "main.js");
// Same reason as desktop-dev.mjs: Electron's sandbox does not start on Linux without setup.
const electronArgs = process.platform === "linux" ? ["--no-sandbox", main] : [main];

const vite = spawn("pnpm", ["--filter", "@zli-v2/web", "exec", "vite", "--port", "5173", "--strictPort"], {
  stdio: "inherit",
});

let electron;
let restarting = false;
let restartTimer;

function startElectron() {
  electron = spawn(electronPath, electronArgs, {
    stdio: "inherit",
    env: { ...process.env, ZLI_RENDERER_URL: RENDERER_URL },
  });
  electron.on("exit", (code) => {
    // Closing the app window ends the dev session; a restart we asked for does not.
    if (!restarting) shutdown(code ?? 0);
  });
}

async function restartElectron() {
  restarting = true;
  if (electron && electron.exitCode === null) {
    const exited = new Promise((done) => electron.once("exit", done));
    electron.kill("SIGTERM");
    await exited;
  }
  restarting = false;
  console.log("[dev-hot] restarting Electron");
  startElectron();
}

let built = false;
const restartOnRebuild = {
  name: "restart-electron",
  setup(build) {
    build.onEnd((result) => {
      if (!built || result.errors.length > 0) return;
      // One save can rebuild several bundles; restart once after they settle.
      clearTimeout(restartTimer);
      restartTimer = setTimeout(restartElectron, 300);
    });
  },
};

await rm(desktopDist, { recursive: true, force: true });
await mkdir(desktopDist, { recursive: true });
const contexts = await Promise.all(bundles.map((options) => context({ ...options, plugins: [restartOnRebuild] })));
await Promise.all(contexts.map((ctx) => ctx.rebuild()));
await Promise.all(contexts.map((ctx) => ctx.watch()));
built = true;

await waitFor(RENDERER_URL);
startElectron();

function shutdown(code) {
  clearTimeout(restartTimer);
  restarting = true;
  electron?.kill("SIGTERM");
  vite.kill("SIGTERM");
  Promise.all(contexts.map((ctx) => ctx.dispose())).finally(() => process.exit(code));
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

async function waitFor(url) {
  for (;;) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((done) => setTimeout(done, 200));
    }
  }
}
