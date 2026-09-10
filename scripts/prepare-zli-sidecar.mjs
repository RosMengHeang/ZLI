import { execFileSync } from "node:child_process";
import { copyFileSync, chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function isWindowsTarget(targetTriple) {
  return targetTriple.includes("windows");
}

export function sidecarFileName(targetTriple) {
  return `zli-${targetTriple}${isWindowsTarget(targetTriple) ? ".exe" : ""}`;
}

export function builtBinaryPath(targetDir, targetTriple, hasExplicitTarget) {
  return path.join(
    targetDir,
    ...(hasExplicitTarget ? [targetTriple] : []),
    "release",
    `zli${isWindowsTarget(targetTriple) ? ".exe" : ""}`,
  );
}

export function prepareZliSidecar(root = projectRoot, environment = process.env) {
  const manifestPath = path.join(root, "src-tauri", "Cargo.toml");
  const explicitTarget = environment.CARGO_BUILD_TARGET?.trim() || "";
  const targetTriple = explicitTarget || execFileSync("rustc", ["--print", "host-tuple"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  if (!targetTriple) throw new Error("Rust did not report a target triple");

  const targetDir = path.resolve(root, environment.CARGO_TARGET_DIR || path.join("src-tauri", "target"));
  const cargoArguments = ["build", "--manifest-path", manifestPath, "--release", "--bin", "zli"];
  if (explicitTarget) cargoArguments.push("--target", explicitTarget);
  execFileSync("cargo", cargoArguments, { cwd: root, env: environment, stdio: "inherit" });

  const source = builtBinaryPath(targetDir, targetTriple, Boolean(explicitTarget));
  const destinationDirectory = path.join(root, "src-tauri", "binaries");
  const destination = path.join(destinationDirectory, sidecarFileName(targetTriple));
  mkdirSync(destinationDirectory, { recursive: true });
  copyFileSync(source, destination);
  if (!isWindowsTarget(targetTriple)) chmodSync(destination, 0o755);
  return destination;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  process.stdout.write(`${prepareZliSidecar()}\n`);
}
