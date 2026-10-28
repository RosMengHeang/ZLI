import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const main = resolve(root, "apps/desktop/dist/main.js");

// On Linux, Electron's sandbox needs either unprivileged user namespaces or a setuid
// chrome-sandbox. Ubuntu 24.04 blocks the former and an npm install does not set up the
// latter, so Electron aborts unless the dev run disables the sandbox. Packaged builds keep it.
const args = process.platform === "linux" ? ["--no-sandbox", main] : [main];

const child = spawn(electronPath, args, { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
