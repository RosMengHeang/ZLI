import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareZliSidecar } from "./prepare-zli-sidecar.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function tauriArguments(arguments_) {
  if (arguments_[0] !== "build") return arguments_;
  return [
    ...arguments_,
    "--config",
    JSON.stringify({ bundle: { externalBin: ["binaries/zli", "binaries/zli-browser-use"] } }),
  ];
}

export function runTauri(arguments_ = process.argv.slice(2)) {
  if (arguments_[0] === "build") prepareZliSidecar(projectRoot);
  const cli = path.join(projectRoot, "node_modules", "@tauri-apps", "cli", "tauri.js");
  const result = spawnSync(process.execPath, [cli, ...tauriArguments(arguments_)], {
    cwd: projectRoot,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runTauri();
}
