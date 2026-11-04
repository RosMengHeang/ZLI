import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { accessSync, constants, writeFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";

/**
 * Squirrel.Mac, which electron-updater uses on macOS, only installs into an app signed with a
 * stable Developer ID. Unsigned and ad-hoc builds fail that check inside ShipIt, and electron-updater
 * 6.8 has no macOS switch for it (`verifyUpdateCodeSignature` is the Windows Authenticode hook).
 * These builds use the same sha512-checked zip, then replace ZLI.app after the process exits.
 * A translocated or read-only copy still sends the person to the release page.
 */
export const MAC_APP_BUNDLE_NAME = "ZLI.app";

const SAFE_ABSOLUTE_PATH = /^\/[^\0\r\n]+$/u;

/** The .app that contains this executable, or undefined when it is not inside one. */
export function macAppBundle(execPath: string): string | undefined {
  const parts = execPath.split(sep).filter((part) => part.length > 0);
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (parts[index]?.endsWith(".app")) return sep + parts.slice(0, index + 1).join(sep);
  }
  return undefined;
}

/** macOS runs a quarantined app from a read-only copy. Replacing that copy does not update the original. */
export function isTranslocatedMacApp(bundlePath: string): boolean {
  return bundlePath.split(sep).includes("AppTranslocation");
}

/** The installed app can be replaced only when its parent folder is writable. */
export function bundleParentWritable(bundlePath: string): boolean {
  try {
    accessSync(dirname(bundlePath), constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function unsignedMacInstallPaths(settingsPath: string): { logPath: string; errorPath: string } {
  const directory = dirname(settingsPath);
  return {
    logPath: join(directory, "unsigned-mac-update.log"),
    errorPath: join(directory, "unsigned-mac-update-error.txt"),
  };
}

/** The first line of a swap that failed after ZLI exited, then the file is removed so it shows once. */
export async function readUnsignedMacInstallError(errorPath: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(errorPath, "utf8");
  } catch {
    return undefined;
  }
  await rm(errorPath, { force: true }).catch(() => undefined);
  const line = text
    .split(/\r?\n/u)
    .find((part) => part.trim())
    ?.trim();
  return line ? line.slice(0, 300) : undefined;
}

export function assertInstallPaths(zipPath: string, bundlePath: string): void {
  if (!SAFE_ABSOLUTE_PATH.test(zipPath) || !zipPath.endsWith(".zip")) {
    throw new Error("The update download is not a zip file.");
  }
  if (!SAFE_ABSOLUTE_PATH.test(bundlePath) || !bundlePath.endsWith(`/${MAC_APP_BUNDLE_NAME}`)) {
    throw new Error("ZLI could not find the installed app to replace.");
  }
}

type InstallSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => {
  unref(): void;
};

const KEPT_ENV = ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL"] as const;

/**
 * Starts a detached helper that waits for this process to exit, swaps in the downloaded app, and
 * opens it. Paths are passed in the environment so the shell does not interpret them.
 */
export function startUnsignedMacInstall(options: {
  zipPath: string;
  bundlePath: string;
  pid: number;
  logPath: string;
  errorPath: string;
  pathEnv?: string;
  spawn?: InstallSpawn;
}): void {
  assertInstallPaths(options.zipPath, options.bundlePath);
  if (!Number.isInteger(options.pid) || options.pid <= 0) throw new Error("ZLI could not start the update installer.");
  const scriptPath = join(tmpdir(), `zli-update-${options.pid}.sh`);
  writeFileSync(scriptPath, UNSIGNED_MAC_UPDATE_SCRIPT, { mode: 0o755 });
  const env: NodeJS.ProcessEnv = { PATH: options.pathEnv ?? "/usr/bin:/bin:/usr/sbin:/sbin" };
  for (const key of KEPT_ENV) {
    const value = process.env[key];
    if (value && !/[\0\r\n]/u.test(value)) env[key] = value;
  }
  env.ZLI_UPDATE_PID = String(options.pid);
  env.ZLI_UPDATE_ZIP = options.zipPath;
  env.ZLI_UPDATE_BUNDLE = options.bundlePath;
  env.ZLI_UPDATE_APP_NAME = MAC_APP_BUNDLE_NAME;
  env.ZLI_UPDATE_LOG = options.logPath;
  env.ZLI_UPDATE_ERROR = options.errorPath;
  const spawn = options.spawn ?? (nodeSpawn as InstallSpawn);
  const child = spawn("/bin/bash", [scriptPath], { detached: true, stdio: "ignore", env });
  child.unref();
}

/** bash 3.2 compatible. ditto, xattr, and open are macOS tools; tests stub them on PATH. */
export const UNSIGNED_MAC_UPDATE_SCRIPT = `#!/bin/bash
set -u
log() { printf '%s\\n' "$1" >>"\${ZLI_UPDATE_LOG}"; }
fail() {
  printf '%s\\n' "$1" >"\${ZLI_UPDATE_ERROR}"
  log "$1"
  exit 1
}

: "\${ZLI_UPDATE_PID:?}"
: "\${ZLI_UPDATE_ZIP:?}"
: "\${ZLI_UPDATE_BUNDLE:?}"
: "\${ZLI_UPDATE_APP_NAME:?}"
: "\${ZLI_UPDATE_LOG:?}"
: "\${ZLI_UPDATE_ERROR:?}"

rm -f "\${ZLI_UPDATE_ERROR}"
log "waiting for \${ZLI_UPDATE_PID}"

while kill -0 "\${ZLI_UPDATE_PID}" 2>/dev/null; do
  sleep 0.2
done
sleep 0.5

work=$(mktemp -d "\${TMPDIR:-/tmp}/zli-update.XXXXXX") || fail "Could not create a temporary folder for the update."
trap 'rm -rf "\${work}"' EXIT

if ! ditto -x -k "\${ZLI_UPDATE_ZIP}" "\${work}"; then
  fail "Could not open the downloaded update."
fi

new_app="\${work}/\${ZLI_UPDATE_APP_NAME}"
if [[ ! -d "\${new_app}" ]]; then
  fail "The downloaded update did not contain \${ZLI_UPDATE_APP_NAME}."
fi

xattr -dr com.apple.quarantine "\${new_app}" 2>/dev/null || true

parent=$(dirname "\${ZLI_UPDATE_BUNDLE}")
backup="\${parent}/.\${ZLI_UPDATE_APP_NAME}.zli-previous"
rm -rf "\${backup}"

move() {
  attempt=1
  while [[ "\${attempt}" -le 10 ]]; do
    if mv "$1" "$2"; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 0.3
  done
  return 1
}

if ! move "\${ZLI_UPDATE_BUNDLE}" "\${backup}"; then
  fail "ZLI could not move the installed app aside."
fi

if ! move "\${new_app}" "\${ZLI_UPDATE_BUNDLE}"; then
  move "\${backup}" "\${ZLI_UPDATE_BUNDLE}" || true
  fail "ZLI could not replace the installed app, so the previous version was put back."
fi

rm -rf "\${backup}"
xattr -dr com.apple.quarantine "\${ZLI_UPDATE_BUNDLE}" 2>/dev/null || true
log "replaced \${ZLI_UPDATE_BUNDLE}"
open "\${ZLI_UPDATE_BUNDLE}" || fail "ZLI was replaced, but it did not open."
`;
