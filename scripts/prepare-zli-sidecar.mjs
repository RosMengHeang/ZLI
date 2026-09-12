import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function isWindowsTarget(targetTriple) {
  return targetTriple.includes("windows");
}

export function sidecarFileName(targetTriple) {
  return `zli-${targetTriple}${isWindowsTarget(targetTriple) ? ".exe" : ""}`;
}

export function browserUseSidecarFileName(targetTriple) {
  return `zli-browser-use-${targetTriple}${isWindowsTarget(targetTriple) ? ".exe" : ""}`;
}

export function builtBinaryPath(targetDir, targetTriple, hasExplicitTarget) {
  return path.join(
    targetDir,
    ...(hasExplicitTarget ? [targetTriple] : []),
    "release",
    `zli${isWindowsTarget(targetTriple) ? ".exe" : ""}`,
  );
}

export function browserUseBuiltBinaryPath(targetDir, targetTriple, hasExplicitTarget) {
  return path.join(
    targetDir,
    ...(hasExplicitTarget ? [targetTriple] : []),
    "release",
    `zli-browser-use${isWindowsTarget(targetTriple) ? ".exe" : ""}`,
  );
}

function isLockError(error) {
  const code = error?.code;
  if (code === "EBUSY" || code === "EPERM" || code === "EACCES" || code === "ETXTBSY") {
    return true;
  }
  const message = String(error?.message ?? error).toLowerCase();
  return (
    message.includes("being used by another process")
    || message.includes("ebusy")
    || message.includes("resource busy")
    || message.includes("text file busy")
  );
}

/**
 * Copy a built binary into the sidecar destination. Never silently clobber a
 * locked/in-use target: on lock failure leave `<dest>.new` and throw.
 */
export function installSidecarBinary(
  source,
  destination,
  {
    copyFile = copyFileSync,
    exists = existsSync,
    remove = unlinkSync,
  } = {},
) {
  if (!exists(destination)) {
    copyFile(source, destination);
    return { destination, staged: null };
  }

  const staging = `${destination}.new`;
  try {
    copyFile(source, staging);
  } catch (error) {
    throw error;
  }

  try {
    copyFile(staging, destination);
  } catch (error) {
    if (isLockError(error)) {
      throw new Error(
        `Refusing to overwrite in-use sidecar '${destination}'; wrote '${staging}' instead. Stop the running process and retry. (${error.code ?? error.message})`,
      );
    }
    try {
      remove(staging);
    } catch {
      // Keep staging if cleanup fails; the overwrite error is primary.
    }
    throw error;
  }

  try {
    remove(staging);
  } catch {
    // Destination is updated; orphan staging is non-fatal.
  }
  return { destination, staged: null };
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
  const cargoArguments = ["build", "--manifest-path", manifestPath, "--release", "--bin", "zli", "--bin", "zli-browser-use"];
  if (explicitTarget) cargoArguments.push("--target", explicitTarget);
  execFileSync("cargo", cargoArguments, { cwd: root, env: environment, stdio: "inherit" });

  const source = builtBinaryPath(targetDir, targetTriple, Boolean(explicitTarget));
  const destinationDirectory = path.join(root, "src-tauri", "binaries");
  const destination = path.join(destinationDirectory, sidecarFileName(targetTriple));
  const browserUseSource = browserUseBuiltBinaryPath(targetDir, targetTriple, Boolean(explicitTarget));
  const browserUseDestination = path.join(destinationDirectory, browserUseSidecarFileName(targetTriple));
  mkdirSync(destinationDirectory, { recursive: true });
  installSidecarBinary(source, destination);
  installSidecarBinary(browserUseSource, browserUseDestination);
  if (!isWindowsTarget(targetTriple)) chmodSync(destination, 0o755);
  if (!isWindowsTarget(targetTriple)) chmodSync(browserUseDestination, 0o755);
  return destination;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  process.stdout.write(`${prepareZliSidecar()}\n`);
}
