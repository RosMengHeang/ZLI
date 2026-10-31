import { spawn, spawnSync } from "node:child_process";
import { watch } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";
import { createServer } from "vite";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const main = resolve(root, "apps/desktop/dist/main.js");

// On Linux, Electron's sandbox needs either unprivileged user namespaces or a setuid
// chrome-sandbox. Ubuntu 24.04 blocks the former and an npm install does not set up the
// latter, so Electron aborts unless the dev run disables the sandbox. Packaged builds keep it.
const args = process.platform === "linux" ? ["--no-sandbox", main] : [main];

// The renderer is served by Vite, so UI edits hot reload in place.
const vite = await createServer({
  root: resolve(root, "apps/web"),
  configFile: resolve(root, "apps/web/vite.config.ts"),
});
await vite.listen();
const rendererUrl = `${vite.resolvedUrls.local[0]}index.html`;

let child;
let restarting = false;
function start() {
  child = spawn(electronPath, args, { stdio: "inherit", env: { ...process.env, ZLI_RENDERER_URL: rendererUrl } });
  child.on("exit", async (code) => {
    if (restarting) return;
    await vite.close();
    process.exit(code ?? 1);
  });
}
start();

// Main process, preload and server code cannot hot swap, so an edit rebuilds them and restarts Electron.
let timer;
function restart() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    const build = spawnSync(process.execPath, [resolve(root, "scripts/build.mjs")], { stdio: "inherit" });
    if (build.status !== 0) return;
    restarting = true;
    child.once("exit", () => {
      restarting = false;
      start();
    });
    child.kill();
  }, 200);
}
for (const dir of ["apps/desktop/src", "apps/server/src", "packages"]) {
  watch(resolve(root, dir), { recursive: true }, (_event, file) => {
    if (file?.endsWith(".ts") && !file.includes("node_modules") && !file.endsWith(".test.ts")) restart();
  });
}
